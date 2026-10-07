import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { STATUS_CLASS_SQL } from "../src/dashboard/logs";

// The query of pageQuery (src/lib/page.ts) for the request log, with a
// cursor.
async function plan(where: string, ...binds: (string | number)[]) {
  const { results } = await env.DB.prepare(
    `EXPLAIN QUERY PLAN SELECT * FROM api_requests
     WHERE ${where} AND (created_at, id) < (?, ?)
     ORDER BY created_at DESC, id DESC LIMIT 51`,
  )
    .bind(...binds, 5, "x")
    .all<{ detail: string }>();

  return results.map((r) => r.detail).join(" | ");
}

describe("request log query plans", () => {
  it("reads a status class in the order of the list", async () => {
    const detail = await plan(STATUS_CLASS_SQL, 4);

    expect(detail).toContain("api_requests_class");
    expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("reads one status in the order of the list", async () => {
    const detail = await plan("status = ?", 404);

    expect(detail).toContain("api_requests_status");
    expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("reads one key from an index", async () => {
    const detail = await plan("api_key_id = ?", "k");

    expect(detail).toContain("api_requests_key");
    expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("returns the right rows for a class", async () => {
    await env.DB.prepare("DELETE FROM api_requests").run();
    await env.DB.prepare(
      `INSERT INTO api_requests (id, created_at, method, path, status, duration_ms) VALUES
       ('a', 1, 'GET', '/a', 404, 1), ('b', 2, 'GET', '/b', 200, 1),
       ('c', 3, 'GET', '/c', 422, 1), ('d', 4, 'GET', '/d', 500, 1),
       ('e', 5, 'GET', '/e', 499, 1), ('f', 6, 'GET', '/f', 500, 1)`,
    ).run();

    const { results } = await env.DB.prepare(
      `SELECT id FROM api_requests WHERE ${STATUS_CLASS_SQL} ORDER BY created_at DESC, id DESC`,
    )
      .bind(4)
      .all<{ id: string }>();

    expect(results.map((r) => r.id)).toEqual(["e", "c", "a"]);
  });
});
