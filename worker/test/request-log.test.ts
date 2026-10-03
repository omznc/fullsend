import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { call, dashSession, newKey } from "./helpers";

interface Row {
  method: string;
  path: string;
  status: number;
  api_key_id: string | null;
  error_name: string | null;
  error_message: string | null;
  duration_ms: number;
}

const rows = async (): Promise<Row[]> =>
  (
    await env.DB.prepare(
      "SELECT * FROM api_requests ORDER BY created_at",
    ).all<Row>()
  ).results;

// The Worker writes the row after the response, so wait for it.
async function waitForRows(count: number): Promise<Row[]> {
  for (let i = 0; i < 50; i++) {
    const found = await rows();

    if (found.length >= count) return found;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return rows();
}

// Gives a slow write time to finish, to show that no row appears.
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM api_requests").run();
});

describe("request log", () => {
  it("logs a request with the key id and the path", async () => {
    const { token, id } = await newKey();

    const res = await call("/emails/does-not-exist?x=1", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);

    const [row, ...rest] = await waitForRows(1);

    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      method: "GET",
      path: "/emails/does-not-exist",
      status: 404,
      api_key_id: id,
      error_name: "not_found",
    });
    expect(row!.error_message).toBeTruthy();
    expect(row!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("logs a success with no error", async () => {
    const { token } = await newKey();

    await call("/domains", { headers: { Authorization: `Bearer ${token}` } });

    const [row] = await waitForRows(1);

    expect(row).toMatchObject({ status: 200, error_name: null });
    expect(row!.error_message).toBeNull();
  });

  it("logs a request with no key and never stores the token", async () => {
    await call("/emails");
    await call("/emails", {
      headers: { Authorization: "Bearer fs_bad_token" },
    });

    const found = await waitForRows(2);

    expect(found.map((r) => [r.status, r.error_name, r.api_key_id])).toEqual([
      [401, "missing_api_key", null],
      [403, "invalid_api_key", null],
    ]);
    expect(JSON.stringify(found)).not.toContain("fs_bad_token");
  });

  it("does not log tracking, health or dashboard requests", async () => {
    await call("/health");
    await call("/t/o/unknown.gif");
    await call("/api/session");

    const { token } = await newKey();
    await call("/domains", { headers: { Authorization: `Bearer ${token}` } });

    const found = await waitForRows(1);
    await settle();

    expect((await rows()).map((r) => r.path)).toEqual(["/domains"]);
    expect(found).toHaveLength(1);
  });

  it("keeps the response when the log write fails", async () => {
    const { token } = await newKey();

    await env.DB.prepare(
      "ALTER TABLE api_requests RENAME TO api_requests_off",
    ).run();

    try {
      const res = await call("/domains", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      await settle();
    } finally {
      await env.DB.prepare(
        "ALTER TABLE api_requests_off RENAME TO api_requests",
      ).run();
    }

    expect(await rows()).toEqual([]);
  });

  it("stops when the owner turns the setting off", async () => {
    const headers = await dashSession();
    const { token } = await newKey();

    const off = await call("/api/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ request_log: "false" }),
    });

    expect(off.status).toBe(200);

    await call("/domains", { headers: { Authorization: `Bearer ${token}` } });
    await settle();

    expect(await rows()).toEqual([]);

    await call("/api/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ request_log: "true" }),
    });

    await call("/domains", { headers: { Authorization: `Bearer ${token}` } });

    expect(await waitForRows(1)).toHaveLength(1);
  });
});
