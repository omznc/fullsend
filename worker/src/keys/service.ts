import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { apiKeys, domains } from "../db/schema";
import type { Env } from "../env";
import { randomBase62, sha256Hex } from "../lib/crypto";
import { ApiError, notFound, validation } from "../lib/errors";
import { inPageOrder, type Page, pageQuery } from "../lib/page";
import { getSetting } from "../lib/settings";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

export function newKeyToken(): string {
  return `fs_${randomBase62(32)}`;
}

// Checks a key name: not empty, 50 characters or fewer.
export function checkKeyName(value: string): string {
  const name = value.trim();

  if (!name) throw validation("The `name` field must not be empty.");

  if (name.length > 50) throw validation("The `name` field is too long.");

  return name;
}

export async function createKey(
  env: Env,
  input: {
    name: string;
    permission?: "full_access" | "sending_access";
    domain_id?: string | null;
    rate_limit?: number | null;
  },
): Promise<{ id: string; token: string; row: ApiKeyRow }> {
  const name = checkKeyName(input.name);
  const permission = input.permission ?? "full_access";

  if (input.domain_id && permission !== "sending_access") {
    throw validation("A `domain_id` needs the `sending_access` permission.");
  }

  if (input.domain_id) {
    const db = getDb(env);

    const domain = await db.query.domains.findFirst({
      where: eq(domains.id, input.domain_id),
    });

    if (!domain) throw notFound("Domain");
  }

  const rateLimit =
    input.rate_limit ?? Number(await getSetting(env, "default_rate_limit"));

  if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 1000) {
    throw validation("The `rate_limit` must be from 1 to 1000.");
  }

  const token = newKeyToken();

  const row: ApiKeyRow = {
    id: crypto.randomUUID(),
    name,
    keyHash: await sha256Hex(token),
    prefix: token.slice(0, 10),
    permission,
    domainId: input.domain_id ?? null,
    rateLimit,
    lastUsedAt: null,
    createdAt: Date.now(),
    revokedAt: null,
  };

  await getDb(env).insert(apiKeys).values(row);

  return { id: row.id, token, row };
}

export function listKeys(env: Env): Promise<ApiKeyRow[]> {
  return getDb(env)
    .select()
    .from(apiKeys)
    .where(isNull(apiKeys.revokedAt))
    .orderBy(desc(apiKeys.createdAt));
}

// One page of the active keys, newest first.
export async function listKeysPage(
  env: Env,
  page: Page,
): Promise<{ rows: ApiKeyRow[]; has_more: boolean }> {
  const { rows, has_more } = await pageQuery<{ id: string }>(
    env,
    "api_keys",
    ["revoked_at IS NULL"],
    [],
    page,
  );

  const ids = rows.map((r) => r.id);

  const found = ids.length
    ? await getDb(env).select().from(apiKeys).where(inArray(apiKeys.id, ids))
    : [];

  return { rows: inPageOrder(found, ids), has_more };
}

export async function renameKey(
  env: Env,
  id: string,
  name: string,
): Promise<void> {
  const res = await getDb(env)
    .update(apiKeys)
    .set({ name: checkKeyName(name) })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });

  if (!res.length) throw notFound("API key");
}

export async function revokeKey(env: Env, id: string): Promise<void> {
  const res = await getDb(env)
    .update(apiKeys)
    .set({ revokedAt: Date.now() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });

  if (!res.length) throw notFound("API key");
}

export async function findKeyByToken(
  env: Env,
  token: string,
): Promise<ApiKeyRow | null> {
  const hash = await sha256Hex(token);

  const row = await getDb(env).query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, hash),
  });

  return row ?? null;
}

// The period of the RATE_LIMITER binding in wrangler.jsonc, in seconds.
// The binding does not say when its window ends, so a refused request
// waits one full period at most.
const RATE_PERIOD = 10;

// Checks the rate limit of a key. The binding allows 10 requests per
// second for one bucket. A key with a higher limit spreads its requests
// over more buckets.
export async function checkRateLimit(env: Env, key: ApiKeyRow): Promise<void> {
  const buckets = Math.max(1, Math.round(key.rateLimit / 10));
  const bucket = Math.floor(Math.random() * buckets);

  const { success } = await env.RATE_LIMITER.limit({
    key: `${key.id}:${bucket}`,
  });

  if (!success) {
    throw new ApiError(
      429,
      "rate_limit_exceeded",
      "Too many requests. You can only make 10 requests per second. See rate limit response headers for more information.",
      {
        "retry-after": String(RATE_PERIOD),
        "ratelimit-limit": String(key.rateLimit),
        "ratelimit-remaining": "0",
        "ratelimit-reset": String(RATE_PERIOD),
      },
    );
  }
}
