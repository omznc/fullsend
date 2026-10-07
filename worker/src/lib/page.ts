import type { Env } from "../env";
import { ApiError } from "./errors";

// The cursor options of a Resend list route.
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
        "validation_error",
        "The `limit` must be an integer from 1 to 100.",
      );
    }

    page.limit = limit;
  }

  if (query.after && query.before) {
    throw new ApiError(
      422,
      "validation_error",
      "Use `after` or `before`, not both.",
    );
  }

  if (query.after) page.after = query.after;

  if (query.before) page.before = query.before;

  return page;
}

// Lists rows of a table newest first, with Resend's cursor pages. The
// cursor is the value of the key column (`id` by default). The table
// needs a `created_at` column.
export async function pageQuery<T>(
  env: Env,
  table: string,
  where: string[],
  params: unknown[],
  page: Page,
  keyColumn = "id",
): Promise<{ rows: T[]; has_more: boolean }> {
  const limit = page.limit ?? 20;
  const cursorId = page.after ?? page.before;
  const conds = [...where];
  const binds = [...params];

  if (cursorId) {
    const cursor = await env.DB.prepare(
      `SELECT created_at FROM ${table} WHERE ${keyColumn} = ?`,
    )
      .bind(cursorId)
      .first<{ created_at: number }>();

    if (!cursor)
      throw new ApiError(
        422,
        "validation_error",
        "The cursor id does not exist.",
      );
    conds.push(
      page.after
        ? `(created_at, ${keyColumn}) < (?, ?)`
        : `(created_at, ${keyColumn}) > (?, ?)`,
    );
    binds.push(cursor.created_at, cursorId);
  }

  const order = page.before ? "ASC" : "DESC";

  const sql = `SELECT * FROM ${table} ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
    ORDER BY created_at ${order}, ${keyColumn} ${order} LIMIT ?`;

  const { results } = await env.DB.prepare(sql)
    .bind(...binds, limit + 1)
    .all<T>();

  const has_more = results.length > limit;
  const rows = results.slice(0, limit);

  if (page.before) rows.reverse();

  return { rows, has_more };
}

// Puts rows that a query read by id in the order of the page.
export function inPageOrder<T extends { id: string }>(
  rows: T[],
  ids: string[],
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));

  return ids.flatMap((id) => byId.get(id) ?? []);
}
