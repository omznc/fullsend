import type { Env } from "../env";
import { type EmailRow, recordEvent } from "../events/record";
import { ApiError, notFound, validation } from "../lib/errors";
import type { JsonValue } from "../lib/json";
import { iso, isoOrNull } from "../lib/time";
import { CLAIM_TTL, type EmailDbRow, rowToEmail } from "./consumer";
import type { StoredBody } from "./create";
import { parseSchedule } from "./validate";

export async function getEmail(env: Env, id: string): Promise<EmailRow> {
  const row = await env.DB.prepare("SELECT * FROM emails WHERE id = ?")
    .bind(id)
    .first<EmailDbRow>();

  if (!row) throw notFound("Email");

  return rowToEmail(row);
}

export async function getBody(
  env: Env,
  email: EmailRow,
): Promise<StoredBody | null> {
  if (!email.bodyKey) return null;
  const obj = await env.BODIES.get(email.bodyKey);

  return obj ? obj.json<StoredBody>() : null;
}

// The Resend shape of an email, without the body.
export function emailListJson(e: EmailRow) {
  return {
    id: e.id,
    to: e.to,
    from: e.from,
    created_at: iso(e.createdAt),
    subject: e.subject,
    bcc: e.bcc,
    cc: e.cc,
    reply_to: e.replyTo,
    last_event: e.lastEvent,
    scheduled_at: isoOrNull(e.scheduledAt),
    message_id: e.cfMessageId,
  };
}

export function emailJson(e: EmailRow, body: StoredBody | null) {
  return {
    object: "email" as const,
    ...emailListJson(e),
    html: body?.html ?? null,
    text: body?.text ?? null,
    tags: e.tags ?? [],
  };
}

export interface ListFilter {
  status?: string[];
  domainId?: string;
  apiKeyId?: string;
  tag?: string;
  since?: number;
  until?: number;
  q?: string;
}

export interface Page {
  limit?: number;
  after?: string;
  before?: string;
}

export function parsePage(query: Record<string, string | undefined>): Page {
  const page: Page = {};

  if (query.limit !== undefined) {
    const limit = Number(query.limit);

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(
        422,
        "invalid_parameter",
        "The `limit` must be an integer from 1 to 100.",
      );
    }

    page.limit = limit;
  }

  if (query.after && query.before) {
    throw new ApiError(
      422,
      "invalid_parameter",
      "Use `after` or `before`, not both.",
    );
  }

  if (query.after) page.after = query.after;

  if (query.before) page.before = query.before;

  return page;
}

// Lists rows of a table newest first, with Resend's cursor pages. The
// cursor is a row id.
export async function pageQuery<T>(
  env: Env,
  table: string,
  where: string[],
  params: unknown[],
  page: Page,
): Promise<{ rows: T[]; has_more: boolean }> {
  const limit = page.limit ?? 20;
  const cursorId = page.after ?? page.before;
  const conds = [...where];
  const binds = [...params];

  if (cursorId) {
    const cursor = await env.DB.prepare(
      `SELECT created_at FROM ${table} WHERE id = ?`,
    )
      .bind(cursorId)
      .first<{ created_at: number }>();

    if (!cursor)
      throw new ApiError(
        422,
        "invalid_parameter",
        "The cursor id does not exist.",
      );
    conds.push(
      page.after ? "(created_at, id) < (?, ?)" : "(created_at, id) > (?, ?)",
    );
    binds.push(cursor.created_at, cursorId);
  }

  const order = page.before ? "ASC" : "DESC";

  const sql = `SELECT * FROM ${table} ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
    ORDER BY created_at ${order}, id ${order} LIMIT ?`;

  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit + 1)
    .all<T>();

  const has_more = results.length > limit;
  const rows = results.slice(0, limit);

  if (page.before) rows.reverse();

  return { rows, has_more };
}

export async function listEmails(
  env: Env,
  page: Page,
  filter: ListFilter = {},
) {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.status?.length) {
    where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
    params.push(...filter.status);
  }

  if (filter.domainId) {
    where.push("domain_id = ?");
    params.push(filter.domainId);
  }

  if (filter.apiKeyId) {
    where.push("api_key_id = ?");
    params.push(filter.apiKeyId);
  }

  if (filter.tag) {
    const [name, value] = filter.tag.split(":", 2);
    where.push(
      `EXISTS (SELECT 1 FROM json_each(emails.tags) t WHERE json_extract(t.value, '$.name') = ?${
        value !== undefined ? " AND json_extract(t.value, '$.value') = ?" : ""
      })`,
    );
    params.push(name, ...(value !== undefined ? [value] : []));
  }

  if (filter.since) {
    where.push("created_at >= ?");
    params.push(filter.since);
  }

  if (filter.until) {
    where.push("created_at < ?");
    params.push(filter.until);
  }

  if (filter.q) {
    const like = `%${filter.q.replace(/[%_]/g, "")}%`;
    where.push(
      `(subject LIKE ? OR "to" LIKE ? OR cc LIKE ? OR bcc LIKE ? OR id = ?)`,
    );
    params.push(like, like, like, like, filter.q);
  }

  const { rows, has_more } = await pageQuery<EmailDbRow>(
    env,
    "emails",
    where,
    params,
    page,
  );

  return { emails: rows.map(rowToEmail), has_more };
}

export async function reschedule(
  env: Env,
  id: string,
  value: JsonValue | undefined,
): Promise<EmailRow> {
  const email = await getEmail(env, id);

  if (email.status !== "scheduled")
    throw validation("Only a scheduled email can change its `scheduled_at`.");

  if (value == null)
    throw new ApiError(
      422,
      "missing_required_field",
      "Missing `scheduled_at` field.",
    );
  const at = parseSchedule(value) ?? Date.now();

  const res = await env.DB.prepare(
    `UPDATE emails SET scheduled_at = ?, dispatched_at = NULL
     WHERE id = ? AND status = 'scheduled' AND (claimed_at IS NULL OR claimed_at < ?) AND cf_message_id IS NULL`,
  )
    .bind(at, id, Date.now() - CLAIM_TTL)
    .run();

  if (!res.meta.changes) throw validation("The email is already on its way.");

  return { ...email, scheduledAt: at, dispatchedAt: null };
}

export async function cancelEmail(env: Env, id: string): Promise<void> {
  const email = await getEmail(env, id);

  if (email.status !== "scheduled")
    throw validation("Only a scheduled email can be canceled.");

  const res = await env.DB.prepare(
    `UPDATE emails SET status = 'canceled'
     WHERE id = ? AND status = 'scheduled' AND (claimed_at IS NULL OR claimed_at < ?) AND cf_message_id IS NULL`,
  )
    .bind(id, Date.now() - CLAIM_TTL)
    .run();

  if (!res.meta.changes) throw validation("The email is already on its way.");
  await recordEvent(env, id, { type: "canceled" });
}
