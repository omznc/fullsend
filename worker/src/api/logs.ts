import { Hono } from "hono";
import { notFound } from "../lib/errors";
import { parsePage, pageQuery } from "../lib/page";
import { iso } from "../lib/time";
import { apiKeyAuth, type ApiVars } from "./auth";

// GET /logs and GET /logs/:id read the request log (src/lib/request-log.ts).
// fullsend stores no body and no User-Agent. The fields for them are null,
// except the response body of an error: it is the Resend error body.
export const logsApi = new Hono<ApiVars>();

// A full access key only: a sending key gets restricted_api_key.
logsApi.use(apiKeyAuth());

interface LogRow {
  id: string;
  created_at: number;
  method: string;
  path: string;
  status: number;
  error_name: string | null;
  error_message: string | null;
}

const listItem = (r: LogRow) => ({
  id: r.id,
  created_at: iso(r.created_at),
  endpoint: r.path,
  method: r.method,
  response_status: r.status,
  user_agent: null,
});

logsApi.get("/", async (c) => {
  const { rows, has_more } = await pageQuery<LogRow>(
    c.env,
    "api_requests",
    [],
    [],
    parsePage(c.req.query()),
  );

  return c.json({ object: "list", has_more, data: rows.map(listItem) });
});

logsApi.get("/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM api_requests WHERE id = ?")
    .bind(c.req.param("id"))
    .first<LogRow>();

  if (!row) throw notFound("Log");

  return c.json({
    object: "log",
    ...listItem(row),
    request_body: null,
    response_body:
      row.error_name === null
        ? null
        : {
            statusCode: row.status,
            name: row.error_name,
            message: row.error_message,
          },
  });
});
