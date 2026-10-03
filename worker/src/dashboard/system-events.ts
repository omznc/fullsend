import { Hono } from "hono";
import { type JsonValue, parseJsonText } from "../lib/json";
import { iso } from "../lib/time";
import type { DashVars } from "./auth";

// The failures that are not tied to one email. See logSystemEvent in
// src/lib/system-events.ts.
export const systemEventRoutes = new Hono<DashVars>();

const DEFAULT_LIMIT = 50;

const MAX_LIMIT = 200;

interface EventRow {
  id: string;
  created_at: number;
  level: string;
  source: string;
  message: string;
  detail: string | null;
}

const badParameter = (message: string) => ({
  error: "invalid_parameter",
  message,
});

// Newest first. `after` is the id of the last event of the page before.
systemEventRoutes.get("/", async (c) => {
  const limitText = c.req.query("limit");
  const limit = limitText === undefined ? DEFAULT_LIMIT : Number(limitText);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return c.json(
      badParameter(`The limit must be an integer from 1 to ${MAX_LIMIT}.`),
      422,
    );
  }

  const after = c.req.query("after");
  let cursor: { at: number; id: string } | null = null;

  if (after) {
    const row = await c.env.DB.prepare(
      "SELECT created_at FROM system_events WHERE id = ?",
    )
      .bind(after)
      .first<{ created_at: number }>();

    if (!row) return c.json(badParameter("The after id is not known."), 422);
    cursor = { at: row.created_at, id: after };
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, created_at, level, source, message, detail FROM system_events
     WHERE ?1 IS NULL OR created_at < ?1 OR (created_at = ?1 AND id < ?2)
     ORDER BY created_at DESC, id DESC LIMIT ?3`,
  )
    .bind(cursor?.at ?? null, cursor?.id ?? "", limit + 1)
    .all<EventRow>();

  const page = results.slice(0, limit);

  return c.json({
    data: page.map((r) => ({
      id: r.id,
      created_at: iso(r.created_at),
      level: r.level,
      source: r.source,
      message: r.message,
      detail: r.detail === null ? null : parseDetail(r.detail),
    })),
    has_more: results.length > limit,
  });
});

function parseDetail(text: string): JsonValue {
  try {
    return parseJsonText(text);
  } catch {
    return text;
  }
}

systemEventRoutes.delete("/", async (c) => {
  const done = await c.env.DB.prepare("DELETE FROM system_events").run();

  return c.json({ deleted: done.meta.changes });
});
