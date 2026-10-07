import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FAILURES_SQL } from "../src/dashboard/failures-sql";
import {
  COUNTS_SQL,
  FIRST_EMAIL_SQL,
  SERIES_SQL,
} from "../src/dashboard/overview-sql";

async function plan(sql: string, ...binds: number[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...binds)
    .all<{
      detail: string;
    }>();

  return results.map((r) => r.detail).join(" | ");
}

describe("overview query plans", () => {
  it("reads the failures in index order", async () => {
    const detail = await plan(FAILURES_SQL);

    expect(detail).toContain("emails_status_event");
    expect(detail).not.toContain("emails_scheduled");
    expect(detail).not.toContain("emails_status ");
  });

  it("does not scan the emails table for the ignored filter", async () => {
    for (const sql of [COUNTS_SQL, SERIES_SQL]) {
      const detail = await plan(sql, 1, 2);

      expect(detail).toContain("emails_ignored");
      expect(detail).not.toMatch(/SCAN emails(?! USING (COVERING )?INDEX)/);
    }
  });

  it("reads the first email from the created index", async () => {
    expect(await plan(FIRST_EMAIL_SQL)).toContain("emails_created");
  });

  it("returns the newest failures first", async () => {
    const rows: [string, string, number][] = [
      ["f1", "failed", 10],
      ["f2", "bounced", 30],
      ["f3", "complained", 20],
      ["ok", "delivered", 99],
    ];

    for (const [id, status, at] of rows) {
      await env.DB.prepare(
        `INSERT INTO emails (id, api_key_id, "from", "to", subject, status, last_event, last_event_at, created_at)
         VALUES (?, 'k', 'a@x.com', '[]', 's', ?, ?, ?, 1)`,
      )
        .bind(id, status, status, at)
        .run();
    }

    const { results } = await env.DB.prepare(FAILURES_SQL).all<{
      id: string;
    }>();

    expect(results.map((r) => r.id)).toEqual(["f2", "f3", "f1"]);
  });
});
