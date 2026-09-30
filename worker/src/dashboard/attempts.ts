import type { Context } from "hono";
import type { Env } from "../env";
import type { DashVars } from "./auth";

// The password login and the setup code count the attempts in D1 before
// they check the secret. One SQL statement adds to a count and sets the
// wait, so parallel requests cannot all pass before the wait starts.
//
// There are three counts:
// - The client: one IPv4 address, or one IPv6 /64. A client can change the
//   last 64 bits of an IPv6 address, so the /64 is one client.
// - The site: one IPv6 /48. A routed /48 has 65,536 /64 networks.
// - All clients together, for each minute. Only an attempt that the client
//   and site counts let through adds to this count, so one client cannot
//   stop the login for the other clients.
//
// A client or a site gets some attempts in a row. Then it must wait, and
// each attempt after the wait doubles the wait, up to 1 hour. A correct
// secret clears the counts of the client and the site. Retention in
// src/cron.ts deletes the rows that did not change for 1 day.

export type AttemptRoute = "login" | "unlock";

const CLIENT_FREE = 5;

const SITE_FREE = 20;

const ALL_PER_MINUTE = 60;

const FIRST_WAIT = 60_000;

const MAX_WAIT = 3_600_000;

const MINUTE = 60_000;

// Adds 1 to the count of a key that has no wait now. The attempt that
// reaches the free count sets the first wait. A key that must wait
// gives no row.
const TAKE = `INSERT INTO auth_attempts (key, count, locked_until, updated_at)
  VALUES (?1, 1, 0, ?2)
  ON CONFLICT (key) DO UPDATE SET
    count = count + 1,
    updated_at = ?2,
    locked_until = CASE WHEN count + 1 >= ?3
      THEN ?2 + min(?4 << min(count + 1 - ?3, 6), ?5)
      ELSE 0 END
  WHERE locked_until <= ?2
  RETURNING count`;

const COUNT = `INSERT INTO auth_attempts (key, count, locked_until, updated_at)
  VALUES (?1, 1, 0, ?2)
  ON CONFLICT (key) DO UPDATE SET count = count + 1, updated_at = ?2
  RETURNING count`;

// The groups of 16 bits of an IPv6 address, with "::" expanded.
function hextets(ip: string): string[] | null {
  const halves = ip.toLowerCase().split("::");

  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;

  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...tail];

  if (!all.every((h) => /^[0-9a-f]{1,4}$/.test(h))) return null;

  return all.map((h) => h.replace(/^0+(?=.)/, ""));
}

// The keys to count for one request: the client, and the site for IPv6.
function clientKeys(route: AttemptRoute, ip: string | undefined): string[] {
  // An IPv4-mapped IPv6 address is an IPv4 client.
  const v4 = ip?.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];

  if (v4) return [`${route}:ip:${v4}`];
  const groups = ip ? hextets(ip) : null;

  if (!groups) return [`${route}:ip:${ip ?? "unknown"}`];

  return [
    `${route}:ip:${groups.slice(0, 4).join(":")}::/64`,
    `${route}:site:${groups.slice(0, 3).join(":")}::/48`,
  ];
}

function freeFor(key: string): number {
  return key.includes(":site:") ? SITE_FREE : CLIENT_FREE;
}

// The 429 answer. `until` is the end of the wait, in epoch ms.
function tooMany(c: Context<DashVars>, until: number) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  c.header("Retry-After", String(seconds));

  return c.json(
    {
      error: "too_many_attempts",
      message: `Too many attempts. Wait ${seconds} seconds, then try again.`,
      retry_after: seconds,
    },
    429,
  );
}

// Counts one attempt. It gives a 429 response when the client, its site
// or all clients together must wait, and null when the attempt can go on.
export async function takeAttempt(c: Context<DashVars>, route: AttemptRoute) {
  const env: Env = c.env;
  const now = Date.now();
  const keys = clientKeys(route, c.req.header("CF-Connecting-IP"));

  const taken = await env.DB.batch<{ count: number }>(
    keys.map((key) =>
      env.DB.prepare(TAKE).bind(key, now, freeFor(key), FIRST_WAIT, MAX_WAIT),
    ),
  );

  if (taken.some((r) => r.results.length === 0)) {
    const placeholders = keys.map(() => "?").join(", ");

    const row = await env.DB.prepare(
      `SELECT max(locked_until) AS until FROM auth_attempts
       WHERE key IN (${placeholders})`,
    )
      .bind(...keys)
      .first<{ until: number | null }>();

    return tooMany(c, row?.until ?? now + FIRST_WAIT);
  }

  const minute = Math.floor(now / MINUTE);

  const all = await env.DB.prepare(COUNT)
    .bind(`${route}:all:${minute}`, now)
    .first<{ count: number }>();

  if (!all || all.count > ALL_PER_MINUTE)
    return tooMany(c, (minute + 1) * MINUTE);

  return null;
}

// Clears the counts of the client and its site after a correct secret.
export async function clearAttempts(
  c: Context<DashVars>,
  route: AttemptRoute,
): Promise<void> {
  const env: Env = c.env;
  const keys = clientKeys(route, c.req.header("CF-Connecting-IP"));

  await env.DB.batch(
    keys.map((key) =>
      env.DB.prepare("DELETE FROM auth_attempts WHERE key = ?").bind(key),
    ),
  );
}
