import type { Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { DAY } from "../lib/time";
import { FETCH_TIMEOUT, MAX_PATH_ATTACHMENTS } from "./validate";

// The Worker fetches the attachments with a `path` one by one. A request
// can take MAX_PATH_ATTACHMENTS * FETCH_TIMEOUT before it writes the
// email. The margin covers the R2 and D1 writes.
const WORST_REQUEST = MAX_PATH_ATTACHMENTS * FETCH_TIMEOUT + 2 * 60_000;

// A pending row older than this belongs to a request that died. A new
// request may take the key again. The limit must be longer than the
// longest live request. If it is shorter, a client retry takes the key
// while the first request is alive, and both requests send the email.
// A retry before this limit gets "concurrent_idempotent_requests", as in
// Resend.
const STALE_PENDING = WORST_REQUEST;

// Runs `run` one time for each Idempotency-Key. The key has a scope of
// one API key and stays for 24 hours. The insert of the pending row is
// the lock, so two parallel requests cannot both send.
export async function withIdempotency<T>(
  env: Env,
  apiKeyId: string,
  key: string | undefined,
  request: string,
  run: () => Promise<T>,
): Promise<T> {
  if (key === undefined) return run();

  if (key.length === 0 || key.length > 256) {
    throw new ApiError(
      400,
      "invalid_idempotency_key",
      "The key must be between 1-256 chars.",
    );
  }

  const hash = await sha256Hex(request);
  const now = Date.now();

  await env.DB.prepare(
    `DELETE FROM idempotency_keys WHERE api_key_id = ? AND key = ?
       AND (created_at < ? OR (state = 'pending' AND created_at < ?))`,
  )
    .bind(apiKeyId, key, now - DAY, now - STALE_PENDING)
    .run();

  const inserted = await env.DB.prepare(
    `INSERT INTO idempotency_keys (api_key_id, key, request_hash, state, created_at)
     VALUES (?, ?, ?, 'pending', ?) ON CONFLICT DO NOTHING RETURNING key`,
  )
    .bind(apiKeyId, key, hash, now)
    .first();

  if (!inserted) {
    const row = await env.DB.prepare(
      "SELECT request_hash, state, response FROM idempotency_keys WHERE api_key_id = ? AND key = ?",
    )
      .bind(apiKeyId, key)
      .first<{
        request_hash: string;
        state: string;
        response: string | null;
      }>();

    if (!row) {
      // The row went away between the insert and the select.
      return withIdempotency(env, apiKeyId, key, request, run);
    }

    if (row.request_hash !== hash) {
      throw new ApiError(
        409,
        "invalid_idempotent_request",
        "This idempotency key has been used on a request with a different payload. Idempotency keys should be unique for each request.",
      );
    }

    if (row.state === "pending") {
      throw new ApiError(
        409,
        "concurrent_idempotent_requests",
        "The same idempotency key was used on a request that is still in progress. Try the request again later.",
      );
    }

    // SAFETY: the stored response is JSON.stringify of the T that `run`
    // returned for this key. The request hash is equal, and the request
    // text starts with the operation ("email:", "batch:"), so the same
    // operation made that T.
    return JSON.parse(row.response ?? "null") as T;
  }

  let result: T;

  try {
    result = await run();
  } catch (err) {
    await env.DB.prepare(
      "DELETE FROM idempotency_keys WHERE api_key_id = ? AND key = ?",
    )
      .bind(apiKeyId, key)
      .run();
    throw err;
  }

  await env.DB.prepare(
    "UPDATE idempotency_keys SET state = 'done', response = ? WHERE api_key_id = ? AND key = ?",
  )
    .bind(JSON.stringify(result), apiKeyId, key)
    .run();

  return result;
}
