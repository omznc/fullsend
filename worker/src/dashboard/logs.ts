import { Hono } from "hono";
import { containsSql } from "../lib/contains";
import { pageQuery, parsePage } from "../lib/page";
import { getSettings } from "../lib/settings";
import { iso } from "../lib/time";
import type { DashVars } from "./auth";
import { keyLabel, keyNames } from "./emails";

// The request log (src/lib/request-log.ts) for the Logs screen.
export const logRoutes = new Hono<DashVars>();

interface LogRow {
  id: string;
  created_at: number;
  method: string;
  path: string;
  status: number;
  api_key_id: string | null;
  error_name: string | null;
  error_message: string | null;
  duration_ms: number;
}

const METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

const badParameter = (message: string) => ({
  error: "invalid_parameter",
  message,
});

// The `status` filter: a class such as "4xx", or one exact status.
function statusCondition(
  value: string,
): { sql: string; params: number[] } | null {
  const range = /^([1-5])xx$/.exec(value);

  if (range) {
    const low = Number(range[1]) * 100;

    return { sql: "status >= ? AND status < ?", params: [low, low + 100] };
  }

  if (/^[1-5]\d\d$/.test(value)) {
    return { sql: "status = ?", params: [Number(value)] };
  }

  return null;
}

// Newest first, with the same cursors as the Resend lists.
logRoutes.get("/", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (q.status) {
    const cond = statusCondition(q.status);

    if (!cond) {
      return c.json(
        badParameter("The status must be a class such as 4xx, or a code."),
        422,
      );
    }

    where.push(`(${cond.sql})`);
    params.push(...cond.params);
  }

  if (q.method) {
    const method = q.method.toUpperCase();

    if (!METHODS.has(method)) {
      return c.json(badParameter("The method is not known."), 422);
    }

    where.push("method = ?");
    params.push(method);
  }

  if (q.key) {
    where.push("api_key_id = ?");
    params.push(q.key);
  }

  const search = q.q?.trim();

  if (search) {
    where.push(containsSql("path"));
    params.push(search);
  }

  const [{ rows, has_more }, settings] = await Promise.all([
    pageQuery<LogRow>(c.env, "api_requests", where, params, parsePage(q)),
    getSettings(c.env),
  ]);

  const names = await keyNames(
    c.env,
    rows.flatMap((r) => (r.api_key_id ? [r.api_key_id] : [])),
  );

  return c.json({
    object: "list",
    has_more,
    enabled: settings.request_log !== "false",
    data: rows.map((r) => ({
      id: r.id,
      created_at: iso(r.created_at),
      method: r.method,
      path: r.path,
      status: r.status,
      api_key: r.api_key_id ? keyLabel(r.api_key_id, names) : null,
      error_name: r.error_name,
      error_message: r.error_message,
      duration_ms: r.duration_ms,
    })),
  });
});
