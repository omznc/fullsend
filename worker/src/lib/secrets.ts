import type { Env } from "../env";
import { toBase64Url } from "./crypto";

// Secrets that fullsend makes itself, so the deploy form needs none. D1
// keeps them in the settings table, outside of DEFAULTS, so getSettings
// never returns them. A Worker secret with the same name wins, for a deploy
// that sets one by hand.

type Generated = "session_secret" | "setup_code";

const cache = new Map<Generated, string>();

// Reads the value, or makes it one time. Two first requests at the same
// time both read the row that won the insert.
async function generated(
  env: Env,
  key: Generated,
  make: () => string,
): Promise<string> {
  const hit = cache.get(key);

  if (hit) return hit;
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
  )
    .bind(key, make())
    .run();

  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();

  if (!row?.value) throw new Error(`fullsend could not store ${key}.`);
  cache.set(key, row.value);

  return row.value;
}

const random = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));

// Signs the dashboard sessions, the setup cookie and the click links.
export async function sessionSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;

  return generated(env, "session_secret", () => toBase64Url(random(32)));
}

// Crockford base32: no I, L, O or U, so a person can copy it from a log.
const CODE_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// The one-time code that opens the first setup without a Cloudflare token.
// The Worker writes it to its logs. SETUP_TOKEN replaces it when it is set.
export async function setupCode(env: Env): Promise<string> {
  if (env.SETUP_TOKEN) return env.SETUP_TOKEN;

  return generated(env, "setup_code", () => {
    const chars = [...random(16)].map((b) => CODE_CHARS[b % 32]!).join("");

    return chars.match(/.{4}/g)!.join("-");
  });
}
