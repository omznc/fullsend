import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, dashSession, newKey } from "./helpers";

let headers: Record<string, string>;

let keyId: string;

interface LogPage {
  has_more: boolean;
  enabled: boolean;
  data: {
    id: string;
    path: string;
    status: number;
    api_key: { id: string; name: string } | null;
    error_name: string | null;
  }[];
}

const list = (query: string) => call(`/api/logs${query}`, { headers });

const ids = (page: LogPage) => page.data.map((r) => r.id);

beforeAll(async () => {
  headers = await dashSession();
  keyId = (await newKey()).id;
  await env.DB.prepare("DELETE FROM api_requests").run();

  await env.DB.prepare(
    `INSERT INTO api_requests (id, created_at, method, path, status, api_key_id, error_name, error_message, duration_ms) VALUES
     ('r1', 1000, 'GET', '/emails/abc', 200, ?1, NULL, NULL, 5),
     ('r2', 2000, 'POST', '/emails', 422, ?1, 'validation_error', 'Bad', 7),
     ('r3', 3000, 'GET', '/domains', 500, NULL, 'internal_server_error', 'Oops', 9),
     ('r4', 4000, 'GET', '/emails/100%_x', 404, 'rpc:caller', 'not_found', 'Email not found', 3)`,
  )
    .bind(keyId)
    .run();
});

describe("dashboard logs", () => {
  it("needs a session", async () => {
    expect((await call("/api/logs")).status).toBe(401);
  });

  it("lists newest first with the key name", async () => {
    const page = await (await list("")).json<LogPage>();

    expect(ids(page)).toEqual(["r4", "r3", "r2", "r1"]);
    expect(page.enabled).toBe(true);
    expect(page.has_more).toBe(false);
    expect(page.data[0]!.api_key).toEqual({
      id: "rpc:caller",
      name: "rpc:caller",
    });
    expect(page.data[1]!.api_key).toBeNull();
    expect(page.data[3]!.api_key).toEqual({ id: keyId, name: "test" });
  });

  it("filters by status class and exact status", async () => {
    expect(ids(await (await list("?status=4xx")).json<LogPage>())).toEqual([
      "r4",
      "r2",
    ]);
    expect(ids(await (await list("?status=5xx")).json<LogPage>())).toEqual([
      "r3",
    ]);
    expect(ids(await (await list("?status=422")).json<LogPage>())).toEqual([
      "r2",
    ]);
    expect((await list("?status=bad")).status).toBe(422);
  });

  it("filters by method, key and path", async () => {
    expect(ids(await (await list("?method=post")).json<LogPage>())).toEqual([
      "r2",
    ]);
    expect((await list("?method=TRACE")).status).toBe(422);
    expect(ids(await (await list(`?key=${keyId}`)).json<LogPage>())).toEqual([
      "r2",
      "r1",
    ]);
    expect(ids(await (await list("?q=/emails")).json<LogPage>())).toEqual([
      "r4",
      "r2",
      "r1",
    ]);
  });

  it("escapes the wildcards of a path search", async () => {
    expect(ids(await (await list("?q=0%25_")).json<LogPage>())).toEqual(["r4"]);
    expect(ids(await (await list("?q=%25")).json<LogPage>())).toEqual(["r4"]);
    expect(ids(await (await list("?q=_")).json<LogPage>())).toEqual(["r4"]);
  });

  it("pages with after and before", async () => {
    const first = await (await list("?limit=2")).json<LogPage>();

    expect(ids(first)).toEqual(["r4", "r3"]);
    expect(first.has_more).toBe(true);

    const next = await (await list("?limit=2&after=r3")).json<LogPage>();

    expect(ids(next)).toEqual(["r2", "r1"]);
    expect(next.has_more).toBe(false);

    const prev = await (await list("?limit=2&before=r2")).json<LogPage>();

    expect(ids(prev)).toEqual(["r4", "r3"]);
  });

  it("shows that the log is off", async () => {
    const off = await call("/api/settings", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ request_log: "false" }),
    });

    expect(off.status).toBe(200);
    expect((await (await list("")).json<LogPage>()).enabled).toBe(false);
  });
});
