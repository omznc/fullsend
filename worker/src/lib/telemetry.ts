import type { Env } from "../env";
import { VERSION } from "../version";
import { getSettings, type Settings, setSettings } from "./settings";
import { DAY } from "./time";

export const POSTHOG_URL = "https://eu.i.posthog.com/capture/";

// This is a public project key. It can only write events.
export const POSTHOG_KEY = "phc_x64Zz2UiqkaRpK8Foqvi6hqPhvgepZPCUcfEkAP7Hqh9";

// The fields that need the setting `telemetry_counts`.
export interface Counts {
  auth_mode: string;
  domains: number;
  sent_24h: number;
  failed_24h: number;
  bounced_24h: number;
  errors_24h: number;
}

export interface Ping {
  api_key: string;
  event: "instance_ping";
  distinct_id: string;
  properties: Partial<Counts> & {
    $process_person_profile: false;
    $geoip_disable: true;
    version: string;
  };
}

async function readCounts(env: Env, s: Settings): Promise<Counts> {
  const since = Date.now() - DAY;

  const [events, domains, errors] = await Promise.all([
    env.DB.prepare(
      `SELECT type, COUNT(DISTINCT email_id) AS n FROM email_events
       WHERE created_at >= ? AND type IN ('sent','failed','bounced')
       GROUP BY type`,
    )
      .bind(since)
      .all<{ type: string; n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM domains").first<{ n: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM system_events WHERE level = 'error' AND created_at >= ?",
    )
      .bind(since)
      .first<{ n: number }>(),
  ]);

  const count = (type: string) =>
    events.results.find((r) => r.type === type)?.n ?? 0;

  return {
    auth_mode: s.auth_mode === "password" ? "password" : "access",
    domains: domains?.n ?? 0,
    sent_24h: count("sent"),
    failed_24h: count("failed"),
    bounced_24h: count("bounced"),
    errors_24h: errors?.n ?? 0,
  };
}

// The payload holds the version, and counts when the owner allows them. It
// never holds an address, a domain name, a hostname, an error text or an
// IP address.
export async function buildPing(
  env: Env,
  id: string,
  s: Settings,
): Promise<Ping> {
  const properties: Ping["properties"] = {
    $process_person_profile: false,
    $geoip_disable: true,
    version: VERSION,
  };

  if (s.telemetry_counts === "true")
    Object.assign(properties, await readCounts(env, s));

  return {
    api_key: POSTHOG_KEY,
    event: "instance_ping",
    distinct_id: id,
    properties,
  };
}

// True when the settings allow the ping. A new deploy sends nothing before
// the end of the setup, where step 8 shows the choice. A deploy that
// updates from an older version has a completed setup, so it sends with
// the defaults.
export function pingAllowed(s: Settings): boolean {
  return s.setup_completed === "true" && s.telemetry === "true";
}

export async function sendTelemetry(env: Env): Promise<void> {
  const s = await getSettings(env);

  if (!pingAllowed(s) || env.AUTH_MODE === "dev") return;

  let id = s.telemetry_id;

  if (!id) {
    id = crypto.randomUUID();
    await setSettings(env, { telemetry_id: id });
  }

  // A D1 error here rejects, so the cron logs it.
  const body = JSON.stringify(await buildPing(env, id, s));

  try {
    await fetch(POSTHOG_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // A ping is optional. A failure must not break the cron.
  }
}
