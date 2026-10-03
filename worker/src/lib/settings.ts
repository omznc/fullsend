import type { Env } from "../env";

// Keys in the settings table, with their defaults.
export const DEFAULTS = {
  // Cloudflare Access: the team domain and the application AUD. The setup
  // wizard writes them, so a change needs no redeploy.
  access_team_domain: "",
  access_aud: "",
  access_app_ids: "",
  // The public paths that fullsend last wrote into the "fullsend API"
  // Access application, joined with commas. It shows what fullsend wrote,
  // not the live state in Cloudflare.
  access_paths: "",
  // "password" after the owner chose the password login in the first
  // setup. Empty means Cloudflare Access.
  auth_mode: "",
  // The PBKDF2 hash of the dashboard password (see hashPassword).
  password_hash: "",
  // Hostnames that the setup attached to the Worker.
  api_hostname: "",
  tracking_hostname: "",
  // The first origin that fullsend saw. A fallback for links.
  public_url: "",
  body_retention_days: "30",
  row_retention_days: "90",
  default_rate_limit: "10",
  default_open_tracking: "true",
  default_click_tracking: "true",
  deploy_name: "fullsend",
  setup_completed: "false",
} as const;

export type SettingKey = keyof typeof DEFAULTS;

export type Settings = Record<SettingKey, string>;

function isSettingKey(key: string): key is SettingKey {
  return key in DEFAULTS;
}

export async function getSettings(env: Env): Promise<Settings> {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM settings",
  ).all<{ key: string; value: string }>();

  const out: Settings = { ...DEFAULTS };

  for (const row of results) {
    if (isSettingKey(row.key)) out[row.key] = row.value;
  }

  return out;
}

let cached: { at: number; value: Settings } | null = null;

// Settings for hot paths, at most 30 seconds old in this isolate.
export async function getSettingsCached(env: Env): Promise<Settings> {
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const value = await getSettings(env);
  cached = { at: Date.now(), value };

  return value;
}

export async function getSetting(env: Env, key: SettingKey): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();

  return row?.value ?? DEFAULTS[key];
}

export async function setSettings(
  env: Env,
  values: Partial<Settings>,
): Promise<void> {
  const stmts = Object.entries(values).map(([key, value]) =>
    env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).bind(key, value),
  );

  if (stmts.length) await env.DB.batch(stmts);
  cached = null;
}

// The origin for tracking links: the tracking hostname, else the API
// hostname, else the first origin that fullsend saw.
export function trackingOrigin(s: Settings): string | null {
  if (s.tracking_hostname) return `https://${s.tracking_hostname}`;

  if (s.api_hostname) return `https://${s.api_hostname}`;

  return s.public_url || null;
}
