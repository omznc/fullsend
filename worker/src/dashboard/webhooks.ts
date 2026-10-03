import { Hono } from "hono";
import { WEBHOOK_EVENTS } from "../events/record";
import { notFound } from "../lib/errors";
import { asRecord, readJson } from "../lib/http";
import { isString } from "../lib/json";
import { pageQuery, parsePage } from "../lib/page";
import { iso } from "../lib/time";
import { MAX_ATTEMPTS, RETRY_DELAYS } from "../webhooks/deliver";
import { MAX_REPLAY, replayFailed } from "../webhooks/events";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  redeliver,
  rotateSecret,
  sendTestEvent,
  updateWebhook,
  type WebhookRow,
} from "../webhooks/service";
import type { DashVars } from "./auth";

export const webhookRoutes = new Hono<DashVars>();

interface Stats {
  total: number;
  ok: number;
  last_at: number | null;
  last_status: number | null;
}

async function stats(env: DashVars["Bindings"]): Promise<Map<string, Stats>> {
  const since = Date.now() - 7 * 86_400_000;

  const { results } = await env.DB.prepare(
    `SELECT webhook_id, COUNT(*) AS total,
       SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
       MAX(created_at) AS last_at
     FROM webhook_deliveries WHERE created_at >= ? GROUP BY webhook_id`,
  )
    .bind(since)
    .all<{ webhook_id: string; total: number; ok: number; last_at: number }>();

  const map = new Map<string, Stats>();

  for (const r of results)
    map.set(r.webhook_id, {
      total: r.total,
      ok: r.ok,
      last_at: r.last_at,
      last_status: null,
    });

  return map;
}

function dashWebhook(w: WebhookRow, s?: Stats) {
  const rate = s && s.total ? s.ok / s.total : null;

  return {
    id: w.id,
    endpoint: w.endpoint,
    events: w.events,
    // "failing" when fewer than half of the attempts in 7 days worked.
    status:
      w.status === "enabled" && rate !== null && rate < 0.5
        ? "failing"
        : w.status,
    enabled: w.status === "enabled",
    success_rate: rate,
    attempts_7d: s?.total ?? 0,
    last_attempt_at: s?.last_at ? iso(s.last_at) : null,
    created_at: iso(w.createdAt),
  };
}

webhookRoutes.get("/", async (c) => {
  const [rows, s] = await Promise.all([listWebhooks(c.env), stats(c.env)]);

  return c.json({
    data: rows.map((w) => dashWebhook(w, s.get(w.id))),
    events: WEBHOOK_EVENTS,
  });
});

webhookRoutes.post("/", async (c) => {
  const w = await createWebhook(c.env, asRecord(await readJson(c)));

  return c.json({ ...dashWebhook(w), signing_secret: w.secret });
});

webhookRoutes.get("/:id", async (c) => {
  const w = await getWebhook(c.env, c.req.param("id"));
  const s = await stats(c.env);

  return c.json({
    ...dashWebhook(w, s.get(w.id)),
    signing_secret: w.secret,
    available_events: WEBHOOK_EVENTS,
    // The seconds before each retry. The UI shows the schedule from it.
    retry_delays: RETRY_DELAYS,
    max_attempts: MAX_ATTEMPTS,
  });
});

webhookRoutes.patch("/:id", async (c) => {
  const w = await updateWebhook(
    c.env,
    c.req.param("id"),
    asRecord(await readJson(c)),
  );

  return c.json(dashWebhook(w));
});

webhookRoutes.delete("/:id", async (c) => {
  await deleteWebhook(c.env, c.req.param("id"));

  return c.json({ ok: true });
});

webhookRoutes.post("/:id/rotate", async (c) => {
  const secret = await rotateSecret(c.env, c.req.param("id"));

  return c.json({ signing_secret: secret });
});

webhookRoutes.post("/:id/test", async (c) => {
  const body = asRecord(await readJson(c));

  const messageId = await sendTestEvent(
    c.env,
    c.req.param("id"),
    isString(body.type) ? body.type : undefined,
  );

  return c.json({ message_id: messageId });
});

interface DeliveryRow {
  id: string;
  message_id: string;
  event_id: string | null;
  event_type: string;
  attempt: number;
  status_code: number | null;
  duration_ms: number | null;
  request_body: string;
  response_excerpt: string | null;
  error: string | null;
  created_at: number;
}

// A delivery as the dashboard shows it. Only the detail view has the
// request body and the response excerpt.
interface DeliveryJson {
  id: string;
  message_id: string;
  event_id: string | null;
  event_type: string;
  attempt: number;
  status_code: number | null;
  ok: boolean;
  max_attempts: number;
  // When the queue sends the next attempt. Null when the delivery worked,
  // when no attempt is left, when a later attempt exists, or when the
  // webhook is off.
  next_attempt_at: string | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  request_body?: string;
  response_excerpt?: string | null;
}

const isOk = (status: number | null) =>
  status !== null && status >= 200 && status < 300;

// The time of the latest attempt of each message in the rows.
async function latestAttempts(
  env: DashVars["Bindings"],
  webhookId: string,
  rows: DeliveryRow[],
): Promise<Map<string, number>> {
  const latest = new Map<string, number>();

  if (!rows.length) return latest;

  // The ids go in as one JSON text, because D1 allows 100 bound values at
  // most.
  const { results } = await env.DB.prepare(
    `SELECT message_id, MAX(created_at) AS at FROM webhook_deliveries
     WHERE webhook_id = ? AND message_id IN (SELECT value FROM json_each(?))
     GROUP BY message_id`,
  )
    .bind(
      webhookId,
      JSON.stringify([...new Set(rows.map((r) => r.message_id))]),
    )
    .all<{ message_id: string; at: number }>();

  for (const r of results) latest.set(r.message_id, r.at);

  return latest;
}

function nextAttemptAt(
  d: DeliveryRow,
  latest: Map<string, number>,
  enabled: boolean,
): string | null {
  const delay = RETRY_DELAYS[d.attempt - 1];

  if (!enabled || isOk(d.status_code) || delay === undefined) return null;

  // A later attempt of the same message replaces this one.
  if ((latest.get(d.message_id) ?? 0) > d.created_at) return null;

  return iso(d.created_at + delay * 1000);
}

function delivery(
  d: DeliveryRow,
  latest: Map<string, number>,
  enabled: boolean,
  full = false,
): DeliveryJson {
  const out: DeliveryJson = {
    id: d.id,
    message_id: d.message_id,
    event_id: d.event_id,
    event_type: d.event_type,
    attempt: d.attempt,
    status_code: d.status_code,
    ok: isOk(d.status_code),
    max_attempts: MAX_ATTEMPTS,
    next_attempt_at: nextAttemptAt(d, latest, enabled),
    duration_ms: d.duration_ms,
    error: d.error,
    created_at: iso(d.created_at),
  };

  if (full) {
    out.request_body = d.request_body;
    out.response_excerpt = d.response_excerpt;
  }

  return out;
}

webhookRoutes.get("/:id/deliveries", async (c) => {
  const id = c.req.param("id");
  const hook = await getWebhook(c.env, id);
  const where = ["webhook_id = ?"];
  const params: string[] = [id];
  const ok = c.req.query("ok");
  const type = c.req.query("event_type");

  if (ok !== undefined && ok !== "") {
    if (ok !== "true" && ok !== "false") {
      return c.json(
        {
          error: "invalid_parameter",
          message: "The ok filter is true or false.",
        },
        422,
      );
    }

    // A call without a status code did not get an answer, so it failed.
    where.push(
      ok === "true"
        ? "status_code BETWEEN 200 AND 299"
        : "(status_code IS NULL OR status_code NOT BETWEEN 200 AND 299)",
    );
  }

  if (type) {
    where.push("event_type = ?");
    params.push(type);
  }

  const { rows, has_more } = await pageQuery<DeliveryRow>(
    c.env,
    "webhook_deliveries",
    where,
    params,
    parsePage(c.req.query()),
  );

  const latest = await latestAttempts(c.env, id, rows);
  const enabled = hook.status === "enabled";

  return c.json({
    has_more,
    data: rows.map((d) => delivery(d, latest, enabled)),
  });
});

webhookRoutes.get("/:id/deliveries/:did", async (c) => {
  const hook = await getWebhook(c.env, c.req.param("id"));

  const d = await c.env.DB.prepare(
    "SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ?",
  )
    .bind(c.req.param("did"), hook.id)
    .first<DeliveryRow>();

  if (!d) throw notFound("Delivery");

  const latest = await latestAttempts(c.env, hook.id, [d]);

  return c.json(delivery(d, latest, hook.status === "enabled", true));
});

webhookRoutes.post("/:id/deliveries/:did/resend", async (c) => {
  await redeliver(c.env, c.req.param("id"), c.req.param("did"));

  return c.json({ ok: true });
});

// Sends the failed events of this webhook again. `since` is an ISO time.
// The call sends the newest MAX_REPLAY events at most.
webhookRoutes.post("/:id/deliveries/resend-failed", async (c) => {
  const body = asRecord(await readJson(c));
  const since = isString(body.since) ? Date.parse(body.since) : Number.NaN;

  if (Number.isNaN(since)) {
    return c.json(
      {
        error: "invalid_parameter",
        message: "Give `since` as a date and time.",
      },
      422,
    );
  }

  const result = await replayFailed(c.env, c.req.param("id"), since);

  return c.json({ ...result, limit: MAX_REPLAY });
});
