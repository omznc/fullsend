import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, dashSession } from "./helpers";

let headers: Record<string, string>;

const BOM = "﻿";

// Reads a CSV body in the simple form that the exports make. A cell with
// a quote has no line break in these tests, so a split by line works.
const lines = (text: string) =>
  text.replace(BOM, "").split("\r\n").filter(Boolean);

beforeAll(async () => {
  headers = await dashSession();
  await env.DB.prepare("DELETE FROM emails").run();
  await env.DB.prepare("DELETE FROM suppressions").run();
});

const insertEmail = env.DB.prepare(
  `INSERT INTO emails (id, api_key_id, "from", "to", subject, status, last_event, last_event_at, created_at, tags)
   VALUES (?1, 'k', ?2, ?3, ?4, ?5, ?5, ?6, ?6, ?7)`,
);

describe("email export", () => {
  it("writes the filtered emails as CSV with safe cells", async () => {
    const now = Date.now();

    await env.DB.batch([
      insertEmail.bind(
        "ex-1",
        "Shop <shop@example.com>",
        JSON.stringify(["a@example.net", "b@example.net"]),
        '=1+1, "quoted"',
        "delivered",
        now - 3000,
        JSON.stringify([
          { name: "campaign", value: "fall" },
          { name: "vip", value: "" },
        ]),
      ),
      insertEmail.bind(
        "ex-2",
        "shop@example.com",
        JSON.stringify(["c@example.net"]),
        "plain subject",
        "bounced",
        now - 2000,
        null,
      ),
      insertEmail.bind(
        "ex-3",
        "shop@example.com",
        JSON.stringify(["d@example.net"]),
        "@later",
        "delivered",
        now - 1000,
        null,
      ),
    ]);

    const res = await call("/api/emails/export", { headers });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="fullsend-emails-\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    // text() drops the byte order mark, so read the bytes.
    const bytes = new Uint8Array(await res.arrayBuffer());

    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);

    const rows = lines(text);

    expect(rows[0]).toBe(
      "id,created_at,from,to,subject,status,last_event,tags",
    );
    // Newest first.
    expect(rows.map((r) => r.split(",")[0])).toEqual([
      "id",
      "ex-3",
      "ex-2",
      "ex-1",
    ]);
    expect(rows[1]).toContain(",'@later,");
    expect(rows[3]).toBe(
      `ex-1,${new Date(now - 3000).toISOString()},Shop <shop@example.com>,a@example.net; b@example.net,"'=1+1, ""quoted""",delivered,delivered,campaign:fall; vip`,
    );
  });

  it("takes the filters of the list", async () => {
    const res = await call("/api/emails/export?status=bounced", { headers });
    const rows = lines(await res.text());

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/^ex-2,/);

    const bad = await call("/api/emails/export?since=nope", { headers });

    expect(bad.status).toBe(422);
  });

  it("needs a session", async () => {
    expect((await call("/api/emails/export")).status).toBe(401);
  });

  it("goes through more than one chunk", async () => {
    const now = Date.now();
    const total = 1203;

    for (let i = 0; i < total; i += 100) {
      await env.DB.batch(
        Array.from({ length: Math.min(100, total - i) }, (_, j) =>
          insertEmail.bind(
            `bulk-${String(i + j).padStart(5, "0")}`,
            "bulk@example.com",
            JSON.stringify(["x@example.net"]),
            "bulk",
            "sent",
            now - 100_000 - (i + j),
            null,
          ),
        ),
      );
    }

    const rows = lines(
      await (await call("/api/emails/export?q=bulk", { headers })).text(),
    );

    expect(rows).toHaveLength(total + 1);
    expect(new Set(rows.map((r) => r.split(",")[0])).size).toBe(total + 1);
  });
});

describe("suppression export", () => {
  it("writes the list as CSV, with the filters", async () => {
    await env.DB.prepare(
      `INSERT INTO suppressions (address, reason, source, email_id, created_at) VALUES
       ('a@x.com', 'hard_bounce', 'dashboard:omar, "admin"', 'em-1', 1000),
       ('=b@x.com', 'complaint', 'test', NULL, 2000),
       ('c@y.com', 'hard_bounce', 'test', NULL, 3000)`,
    ).run();

    const all = lines(
      await (await call("/api/suppressions/export", { headers })).text(),
    );

    expect(all).toEqual([
      "address,reason,source,email_id,created_at",
      `'=b@x.com,complaint,test,,${new Date(2000).toISOString()}`,
      `a@x.com,hard_bounce,"dashboard:omar, ""admin""",em-1,${new Date(1000).toISOString()}`,
      `c@y.com,hard_bounce,test,,${new Date(3000).toISOString()}`,
    ]);

    const filtered = lines(
      await (
        await call("/api/suppressions/export?reason=hard_bounce&q=x.com", {
          headers,
        })
      ).text(),
    );

    expect(filtered).toHaveLength(2);
    expect(filtered[1]).toMatch(/^a@x\.com,/);

    const res = await call("/api/suppressions/export", { headers });

    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="fullsend-suppressions-/,
    );
    expect(
      (await call("/api/suppressions/export?reason=spam", { headers })).status,
    ).toBe(422);
    expect((await call("/api/suppressions/export")).status).toBe(401);
  });
});
