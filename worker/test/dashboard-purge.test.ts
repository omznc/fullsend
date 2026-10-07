import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, dashSession } from "./helpers";

let headers: Record<string, string>;

const count = async (table: string): Promise<number> =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>())!.n;

beforeAll(async () => {
  headers = await dashSession();
});

describe("delete all data", () => {
  it("deletes the request log and the system events", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO api_requests (id, created_at, method, path, status, duration_ms) VALUES ('p1', 1, 'DELETE', '/suppressions/jane@example.com', 200, 1)",
      ),
      env.DB.prepare(
        "INSERT INTO system_events (id, created_at, level, source, message) VALUES ('p2', 1, 'warn', 'test', 'a@example.com failed')",
      ),
      env.DB.prepare(
        "INSERT INTO webhook_replays (webhook_id, message_id, queued_at) VALUES ('w', 'm', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO suppressions (address, reason, source, created_at) VALUES ('jane@example.com', 'manual', 'test', 0)",
      ),
    ]);

    const res = await call("/api/settings/purge", {
      method: "POST",
      headers,
      body: JSON.stringify({ confirm: "delete all data" }),
    });

    expect(res.status).toBe(200);
    expect(await count("api_requests")).toBe(0);
    expect(await count("system_events")).toBe(0);
    expect(await count("suppressions")).toBe(0);
    expect(await count("webhook_replays")).toBe(0);
  });
});
