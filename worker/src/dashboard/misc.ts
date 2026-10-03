import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { listDomains } from "../domains/service";
import { normalize, parseAddress } from "../lib/address";
import { Cloudflare, CloudflareError, hasToken } from "../lib/cloudflare";
import { hashPassword } from "../lib/crypto";
import { validation } from "../lib/errors";
import { asRecord, isHostname, readJson } from "../lib/http";
import { isString } from "../lib/json";
import { likeContains } from "../lib/like";
import { parsePage } from "../lib/page";
import {
  DEFAULTS,
  getSettings,
  type SettingKey,
  setSettings,
} from "../lib/settings";
import { DAY, iso, isoOrNull } from "../lib/time";
import { PUBLIC_PATHS } from "../public-paths";
import { parseAddressColumn } from "../send/consumer";
import { addSuppressions, removeSuppressions } from "../suppressions/service";
import { type DashVars, SESSION_COOKIE, SESSION_TTL, signToken } from "./auth";
import { dashDomain } from "./domains";
import { FAILURES_SQL } from "./failures-sql";
import { cookieOpts, MIN_PASSWORD } from "./setup";

export const miscRoutes = new Hono<DashVars>();

// Overview

// A period of the overview: its length and the length of one bucket.
interface Period {
  span: number;
  bucket: number;
}

const WEEK: Period = { span: 7 * DAY, bucket: DAY };

const PERIODS = new Map<string, Period>([
  ["24h", { span: DAY, bucket: 3_600_000 }],
  ["7d", WEEK],
  ["30d", { span: 30 * DAY, bucket: DAY }],
]);

// "all" starts at the first event. The bucket grows with the span, so the
// chart keeps about 60 bars or fewer: a day, a week or 30 days.
function allTime(first: number | null, now: number): Period {
  if (first === null) return WEEK;
  const span = Math.max(now - first, DAY);

  const bucket =
    span <= 60 * DAY ? DAY : span <= 60 * 7 * DAY ? 7 * DAY : 30 * DAY;

  return { span, bucket };
}

const COUNTED = [
  "sent",
  "delivered",
  "bounced",
  "complained",
  "opened",
  "clicked",
] as const;

async function counts(
  env: DashVars["Bindings"],
  from: number,
  to: number,
): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT type, COUNT(DISTINCT email_id) AS n FROM email_events
     WHERE created_at >= ? AND created_at < ? AND bot IS NULL
       AND type IN ('sent','delivered','bounced','complained','opened','clicked')
     GROUP BY type`,
  )
    .bind(from, to)
    .all<{ type: string; n: number }>();

  const out: Record<string, number> = Object.fromEntries(
    COUNTED.map((t) => [t, 0]),
  );

  for (const r of results) out[r.type] = r.n;

  return out;
}

function level(
  rate: number | null,
  warn: number,
  danger: number,
): "good" | "warning" | "danger" | null {
  if (rate === null) return null;

  if (rate >= danger) return "danger";

  if (rate >= warn) return "warning";

  return "good";
}

miscRoutes.get("/overview", async (c) => {
  const asked = c.req.query("period") ?? "7d";
  const all = asked === "all";
  const name = all || PERIODS.has(asked) ? asked : "7d";
  const now = Date.now();

  const first = all
    ? await c.env.DB.prepare("SELECT MIN(created_at) AS t FROM emails").first<{
        t: number | null;
      }>()
    : null;

  const period = all
    ? allTime(first?.t ?? null, now)
    : (PERIODS.get(name) ?? WEEK);

  const since = now - period.span;

  const [current, previous, series, failures, domains, anyEmail, system] =
    await Promise.all([
      counts(c.env, since, now),
      // "all" has no period before it.
      all ? null : counts(c.env, since - period.span, since),
      c.env.DB.prepare(
        `SELECT (created_at / ?1) * ?1 AS bucket, type, COUNT(DISTINCT email_id) AS n FROM email_events
       WHERE created_at >= ?2 AND bot IS NULL AND type IN ('sent','delivered','bounced')
       GROUP BY bucket, type ORDER BY bucket`,
      )
        .bind(period.bucket, since)
        .all<{ bucket: number; type: string; n: number }>(),
      c.env.DB.prepare(FAILURES_SQL).all<{
        id: string;
        to: string;
        subject: string;
        status: string;
        error: string | null;
        last_event_at: number;
      }>(),
      listDomains(c.env),
      // Only "any email?" matters here. LIMIT 1 stops at the first row.
      c.env.DB.prepare("SELECT 1 AS one FROM emails LIMIT 1").first<{
        one: number;
      }>(),
      // The system events of the last 7 days, whatever the period is.
      c.env.DB.prepare(
        `SELECT COALESCE(SUM(level = 'error'), 0) AS errors,
           COALESCE(SUM(level = 'warn'), 0) AS warnings,
           MAX(created_at) AS latest
         FROM system_events WHERE created_at >= ?`,
      )
        .bind(now - WEEK.span)
        .first<{ errors: number; warnings: number; latest: number | null }>(),
    ]);

  const buckets = new Map<number, Record<string, number>>();
  const start = Math.floor(since / period.bucket) * period.bucket;

  for (let t = start; t <= now; t += period.bucket)
    buckets.set(t, { sent: 0, delivered: 0, bounced: 0 });

  for (const r of series.results) {
    const b = buckets.get(r.bucket);

    if (b) b[r.type] = r.n;
  }

  const bounceRate = current.sent ? current.bounced! / current.sent : null;

  const complaintRate = current.delivered
    ? current.complained! / current.delivered
    : null;

  return c.json({
    period: name,
    has_emails: Boolean(anyEmail),
    stats: COUNTED.map((t) => ({
      type: t,
      value: current[t],
      previous: previous ? previous[t] : null,
    })),
    series: [...buckets].map(([t, v]) => ({ at: iso(t), ...v })),
    bounce_rate: { value: bounceRate, level: level(bounceRate, 0.02, 0.04) },
    complaint_rate: {
      value: complaintRate,
      level: level(complaintRate, 0.001, 0.003),
    },
    recent_failures: failures.results.map((f) => ({
      id: f.id,
      to: parseAddressColumn(f.to),
      subject: f.subject,
      status: f.status,
      reason: f.error,
      at: iso(f.last_event_at),
    })),
    domains: domains.map(dashDomain),
    system_events: {
      errors: system?.errors ?? 0,
      warnings: system?.warnings ?? 0,
      latest_at: isoOrNull(system?.latest),
    },
  });
});

// Global search (Cmd+K)

miscRoutes.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();

  if (q.length < 2)
    return c.json({ emails: [], domains: [], api_keys: [], webhooks: [] });
  const like = likeContains(q);

  const [emails, domains, keys, hooks] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, "to", subject, status, created_at FROM emails
       WHERE id = ? OR cf_message_id = ? OR subject LIKE ? ESCAPE '\\' OR "to" LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 8`,
    )
      .bind(q, q, like, like)
      .all<{
        id: string;
        to: string;
        subject: string;
        status: string;
        created_at: number;
      }>(),
    c.env.DB.prepare(
      "SELECT id, name, status FROM domains WHERE name LIKE ? ESCAPE '\\' LIMIT 5",
    )
      .bind(like)
      .all(),
    c.env.DB.prepare(
      "SELECT id, name, prefix FROM api_keys WHERE revoked_at IS NULL AND (name LIKE ? ESCAPE '\\' OR prefix LIKE ? ESCAPE '\\') LIMIT 5",
    )
      .bind(like, like)
      .all(),
    c.env.DB.prepare(
      "SELECT id, endpoint, status FROM webhooks WHERE endpoint LIKE ? ESCAPE '\\' OR id = ? LIMIT 5",
    )
      .bind(like, q)
      .all(),
  ]);

  return c.json({
    emails: emails.results.map((e) => ({
      ...e,
      to: parseAddressColumn(e.to),
      created_at: iso(e.created_at),
    })),
    domains: domains.results,
    api_keys: keys.results,
    webhooks: hooks.results,
  });
});

// Suppressions

interface SuppressionRow {
  address: string;
  reason: string;
  source: string;
  email_id: string | null;
  created_at: number;
}

miscRoutes.get("/suppressions", async (c) => {
  const q = c.req.query("q")?.trim();
  const where = q ? ["address LIKE ? ESCAPE '\\'"] : [];
  const params = q ? [likeContains(q.toLowerCase())] : [];
  // The cursor is the address: the table has no id column.
  const page = parsePage(c.req.query());
  const limit = page.limit ?? 50;

  if (page.after || page.before) {
    where.push(page.after ? "address > ?" : "address < ?");
    params.push((page.after ?? page.before)!);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM suppressions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY address ${page.before ? "DESC" : "ASC"} LIMIT ?`,
  )
    .bind(...params, limit + 1)
    .all<SuppressionRow>();

  const rows = results.slice(0, limit);

  if (page.before) rows.reverse();

  return c.json({
    has_more: results.length > limit,
    data: rows.map((s) => ({ ...s, created_at: iso(s.created_at) })),
  });
});

miscRoutes.post("/suppressions", async (c) => {
  const body = asRecord(await readJson(c));

  if (!isString(body.address) || !parseAddress(body.address))
    throw validation("Give a valid email address.");

  await addSuppressions(c.env, [
    {
      address: normalize(body.address),
      reason: "manual",
      source: `dashboard:${c.get("identity")}`,
    },
  ]);

  return c.json({ ok: true });
});

miscRoutes.delete("/suppressions/:address", async (c) => {
  await removeSuppressions(c.env, [normalize(c.req.param("address"))]);

  return c.json({ ok: true });
});

// The suppression list that Cloudflare keeps for the account.
miscRoutes.get("/suppressions/cloudflare", async (c) => {
  if (!hasToken(c.env)) return c.json({ available: false, data: [] });

  try {
    const list = await new Cloudflare(c.env).suppressions();

    return c.json({ available: true, data: list });
  } catch (err) {
    return c.json({
      available: false,
      error: err instanceof Error ? err.message : String(err),
      data: [],
    });
  }
});

// Cloudflare token status

async function probe<T>(
  fn: () => Promise<T>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof CloudflareError ? err.message : String(err),
    };
  }
}

miscRoutes.get("/cloudflare", async (c) => {
  if (!hasToken(c.env)) {
    return c.json({
      token_set: false,
      valid: false,
      account: null,
      permissions: null,
    });
  }

  const cf = new Cloudflare(c.env);
  const token = await probe(() => cf.verifyToken());

  if (!token.ok)
    return c.json({
      token_set: true,
      valid: false,
      error: token.error,
      account: null,
      permissions: null,
    });
  let account: { id: string; name: string } | null = null;

  try {
    account = await cf.account();
  } catch {
    account = { id: cf.accountId, name: cf.accountId };
  }

  let zoneId: string | null = null;

  const zone_read = await probe(async () => {
    zoneId = (await cf.zones())[0]?.id ?? null;
  });

  // Access has two permissions: "Apps and Policies" for the apps, and
  // "Organizations, Identity Providers, and Groups" for the team domain.
  const [email_sending, queues, access, access_org, workers_scripts] =
    await Promise.all([
      zoneId
        ? probe(() => cf.sendingDomains(zoneId!))
        : Promise.resolve({ ok: false, error: "no zone to check" }),
      probe(() => cf.queueId(c.env.EVENTS_QUEUE_NAME)),
      probe(() => cf.accessApps()),
      probe(() => cf.accessOrganization()),
      probe(() => cf.workerDomains(c.env.WORKER_NAME)),
    ]);

  return c.json({
    token_set: true,
    valid: true,
    account,
    permissions: {
      zone_read,
      email_sending,
      queues,
      access,
      access_org,
      workers_scripts,
    },
  });
});

miscRoutes.get("/cloudflare/zones", async (c) => {
  if (!hasToken(c.env)) return c.json({ data: [] });
  const zones = await new Cloudflare(c.env).zones();

  return c.json({ data: zones.map((z) => ({ id: z.id, name: z.name })) });
});

// The sending domains of a zone that are already in Email Sending.
miscRoutes.get("/cloudflare/zones/:id/sending-domains", async (c) => {
  if (!hasToken(c.env)) return c.json({ data: [] });
  const list = await new Cloudflare(c.env).sendingDomains(c.req.param("id"));

  return c.json({
    data: list.map((d) => ({ tag: d.tag, name: d.name, enabled: d.enabled })),
  });
});

// Hostnames (Worker custom domains)

miscRoutes.get("/hostnames", async (c) => {
  const s = await getSettings(c.env);
  let attached: { hostname: string }[] = [];
  let error: string | null = null;

  if (hasToken(c.env)) {
    try {
      attached = await new Cloudflare(c.env).workerDomains(c.env.WORKER_NAME);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const status = (h: string) =>
    !h
      ? "unset"
      : attached.some((a) => a.hostname === h)
        ? "active"
        : error
          ? "unknown"
          : "missing";

  return c.json({
    worker_url: new URL(c.req.url).origin,
    api_hostname: {
      hostname: s.api_hostname || null,
      status: status(s.api_hostname),
    },
    tracking_hostname: {
      hostname: s.tracking_hostname || null,
      status: status(s.tracking_hostname),
    },
    error,
  });
});

miscRoutes.post("/hostnames", async (c) => {
  const body = asRecord(await readJson(c));
  const cf = hasToken(c.env) ? new Cloudflare(c.env) : null;

  const results: Record<
    string,
    { hostname: string; status: string; error?: string }
  > = {};

  const patch: Partial<Record<SettingKey, string>> = {};

  for (const key of ["api_hostname", "tracking_hostname"] as const) {
    const value = body[key];

    if (!isString(value)) continue;
    const hostname = value.trim().toLowerCase();

    if (hostname && !isHostname(hostname)) {
      throw validation(
        `\`${key}\` must be a hostname, for example \`email.example.com\`.`,
      );
    }

    patch[key] = hostname;

    if (!hostname) continue;

    if (!cf) {
      results[key] = {
        hostname,
        status: "manual",
        error:
          "No Cloudflare token. Attach the custom domain to the Worker by hand.",
      };
      continue;
    }

    try {
      const zone = await cf.zoneFor(hostname);

      if (!zone)
        throw new Error(`No active zone in this account holds ${hostname}.`);

      const attached = (await cf.workerDomains(c.env.WORKER_NAME)).some(
        (d) => d.hostname === hostname,
      );

      if (!attached)
        await cf.attachWorkerDomain({
          hostname,
          service: c.env.WORKER_NAME,
          zoneId: zone.id,
        });
      results[key] = { hostname, status: "active" };
    } catch (err) {
      results[key] = {
        hostname,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  await setSettings(c.env, patch);

  return c.json(results);
});

// Settings

const EDITABLE: SettingKey[] = [
  "body_retention_days",
  "row_retention_days",
  "default_rate_limit",
  "default_open_tracking",
  "default_click_tracking",
  "deploy_name",
  "setup_completed",
];

const NUMERIC: Partial<Record<SettingKey, [number, number]>> = {
  body_retention_days: [1, 365],
  row_retention_days: [1, 3650],
  default_rate_limit: [1, 1000],
};

miscRoutes.get("/settings", async (c) => {
  const s = await getSettings(c.env);

  return c.json({
    settings: Object.fromEntries(EDITABLE.map((k) => [k, s[k]])),
    api_hostname: s.api_hostname || null,
    tracking_hostname: s.tracking_hostname || null,
    access: {
      team_domain: s.access_team_domain || null,
      configured: Boolean(s.access_team_domain && s.access_aud),
      public_paths: PUBLIC_PATHS,
    },
    cloudflare_token_set: hasToken(c.env),
    auth_mode: s.auth_mode === "password" ? "password" : "access",
  });
});

miscRoutes.patch("/settings", async (c) => {
  const body = asRecord(await readJson(c));
  const patch: Partial<Record<SettingKey, string>> = {};

  for (const key of EDITABLE) {
    if (body[key] === undefined) continue;
    const value = String(body[key]);
    const range = NUMERIC[key];

    if (range) {
      const n = Number(value);

      if (!Number.isInteger(n) || n < range[0] || n > range[1])
        throw validation(`\`${key}\` must be from ${range[0]} to ${range[1]}.`);
    }

    if (DEFAULTS[key] === "true" || DEFAULTS[key] === "false") {
      if (value !== "true" && value !== "false")
        throw validation(`\`${key}\` must be true or false.`);
    }

    patch[key] = value;
  }

  await setSettings(c.env, patch);

  return c.json({ ok: true });
});

// Changes the dashboard password (password mode). The new hash also ends
// every old session, so this sets a new session cookie.
miscRoutes.post("/settings/password", async (c) => {
  const body = asRecord(await readJson(c));
  const s = await getSettings(c.env);

  if (s.auth_mode !== "password")
    throw validation("This deploy uses Cloudflare Access, not a password.");

  if (!isString(body.password) || body.password.length < MIN_PASSWORD) {
    throw validation(
      `The password must have ${MIN_PASSWORD} characters or more.`,
    );
  }

  const hash = await hashPassword(body.password);
  await setSettings(c.env, { password_hash: hash });
  setCookie(
    c,
    SESSION_COOKIE,
    await signToken(c.env, "admin", SESSION_TTL, hash),
    cookieOpts(SESSION_TTL),
  );

  return c.json({ ok: true });
});

// Deletes every email, event, delivery and suppression. Keys, domains,
// webhooks and settings stay.
miscRoutes.post("/settings/purge", async (c) => {
  const body = asRecord(await readJson(c));

  if (body.confirm !== "delete all data")
    throw validation("Type `delete all data` to confirm.");
  let cursor: string | undefined;

  do {
    const list = await c.env.BODIES.list({
      prefix: "emails/",
      cursor,
      limit: 1000,
    });

    if (list.objects.length)
      await c.env.BODIES.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  await c.env.DB.batch(
    [
      "emails",
      "email_events",
      "webhook_deliveries",
      "idempotency_keys",
      "suppressions",
    ].map((t) => c.env.DB.prepare(`DELETE FROM ${t}`)),
  );

  return c.json({ ok: true });
});

// Setup wizard progress

miscRoutes.get("/setup/state", async (c) => {
  const [s, domains, keys, emails] = await Promise.all([
    getSettings(c.env),
    listDomains(c.env),
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL",
    ).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM emails").first<{ n: number }>(),
  ]);

  return c.json({
    cloudflare_token_set: hasToken(c.env),
    domains: domains.map(dashDomain),
    api_keys: keys?.n ?? 0,
    emails: emails?.n ?? 0,
    api_hostname: s.api_hostname || null,
    tracking_hostname: s.tracking_hostname || null,
    setup_completed: s.setup_completed === "true",
  });
});
