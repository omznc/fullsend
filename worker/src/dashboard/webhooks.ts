import { Hono } from "hono";
import { WEBHOOK_EVENTS } from "../events/record";
import { notFound } from "../lib/errors";
import { asRecord, readJson } from "../lib/http";
import { isString } from "../lib/json";
import { iso } from "../lib/time";
import { pageQuery, parsePage } from "../send/manage";
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

  return c.json({ ...dashWebhook(w, s.get(w.id)), signing_secret: w.secret });
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
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  request_body?: string;
  response_excerpt?: string | null;
}

function delivery(d: DeliveryRow, full = false): DeliveryJson {
  const out: DeliveryJson = {
    id: d.id,
    message_id: d.message_id,
    event_id: d.event_id,
    event_type: d.event_type,
    attempt: d.attempt,
    status_code: d.status_code,
    ok: d.status_code !== null && d.status_code >= 200 && d.status_code < 300,
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
  await getWebhook(c.env, id);

  const { rows, has_more } = await pageQuery<DeliveryRow>(
    c.env,
    "webhook_deliveries",
    ["webhook_id = ?"],
    [id],
    parsePage(c.req.query()),
  );

  return c.json({ has_more, data: rows.map((d) => delivery(d)) });
});

webhookRoutes.get("/:id/deliveries/:did", async (c) => {
  const d = await c.env.DB.prepare(
    "SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ?",
  )
    .bind(c.req.param("did"), c.req.param("id"))
    .first<DeliveryRow>();

  if (!d) throw notFound("Delivery");

  return c.json(delivery(d, true));
});

webhookRoutes.post("/:id/deliveries/:did/resend", async (c) => {
  await redeliver(c.env, c.req.param("id"), c.req.param("did"));

  return c.json({ ok: true });
});
