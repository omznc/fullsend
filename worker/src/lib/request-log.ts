import { createMiddleware } from "hono/factory";
import type { ApiVars } from "../api/auth";
import type { Env } from "../env";
import { PUBLIC_PATHS } from "../public-paths";
import type { ApiError } from "./errors";
import { getSettingsCached } from "./settings";
import { errorText } from "./system-events";

// The request log: one api_requests row for each request to a Resend
// route. A row has no body, no header and no API key. The path has no
// query string.

const MAX_TEXT = 500;

// The public paths that the log skips: the tracking links and the health
// check.
const UNLOGGED = new Set(["/t", "/health"]);

// True for a path of a Resend route.
export function isLoggedPath(path: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => !UNLOGGED.has(p) && (path === p || path.startsWith(`${p}/`)),
  );
}

// The error response of each request. `onError` fills this map, and the
// log middleware reads it.
const failures = new WeakMap<Request, ApiError>();

export function noteFailure(req: Request, err: ApiError): void {
  failures.set(req, err);
}

interface LogEntry {
  at: number;
  method: string;
  path: string;
  status: number;
  keyId: string | null;
  error: ApiError | undefined;
  durationMs: number;
}

async function writeEntry(env: Env, e: LogEntry): Promise<void> {
  try {
    const settings = await getSettingsCached(env);

    if (settings.request_log === "false") return;

    await env.DB.prepare(
      `INSERT INTO api_requests
         (id, created_at, method, path, status, api_key_id, error_name, error_message, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        e.at,
        e.method,
        e.path.slice(0, MAX_TEXT),
        e.status,
        e.keyId,
        e.error?.errorName ?? null,
        e.error?.message.slice(0, MAX_TEXT) ?? null,
        e.durationMs,
      )
      .run();
  } catch (err) {
    // A failed log write must never change a response.
    console.error(
      JSON.stringify({ evt: "request_log_failed", error: errorText(err) }),
    );
  }
}

// Writes the log row after the response, with waitUntil, so it adds no
// latency.
export const requestLog = createMiddleware<ApiVars>(async (c, next) => {
  if (!isLoggedPath(c.req.path)) return next();

  const at = Date.now();

  await next();

  try {
    const entry: LogEntry = {
      at,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      keyId: c.get("apiKey")?.id ?? null,
      error: failures.get(c.req.raw),
      durationMs: Date.now() - at,
    };

    c.executionCtx.waitUntil(writeEntry(c.env, entry));
  } catch (err) {
    console.error(
      JSON.stringify({ evt: "request_log_failed", error: errorText(err) }),
    );
  }
});
