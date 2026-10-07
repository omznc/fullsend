import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createWebhook } from "../src/webhooks/service";
import { call, dashSession } from "./helpers";

let headers: Record<string, string>;

// The reply of a stub queue. fullsend does not read it.
const SENT: QueueSendBatchResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

beforeAll(async () => {
  headers = await dashSession();
  await env.DB.prepare("DELETE FROM suppressions").run();

  await env.DB.prepare(
    `INSERT INTO suppressions (address, reason, source, created_at) VALUES
     ('a@x.com', 'hard_bounce', 'test', 1),
     ('b@x.com', 'hard_bounce', 'test', 2),
     ('c@x.com', 'complaint', 'test', 3),
     ('d@y.com', 'manual', 'test', 4)`,
  ).run();
});

interface SuppressionPage {
  has_more: boolean;
  counts: Record<string, number>;
  data: { address: string; reason: string }[];
}

const list = (query: string) => call(`/api/suppressions${query}`, { headers });

interface Batch {
  emails?: string[];
  reason?: string;
}

const batch = (body: Batch) =>
  call("/api/suppressions/batch", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

describe("dashboard suppressions list", () => {
  it("filters by reason on the server and counts each reason", async () => {
    const all = await (await list("")).json<SuppressionPage>();

    expect(all.data).toHaveLength(4);
    expect(all.counts).toEqual({ hard_bounce: 2, complaint: 1, manual: 1 });

    // A page of one row still has the counts of the whole list.
    const page = await (
      await list("?reason=hard_bounce&limit=1")
    ).json<SuppressionPage>();

    expect(page.data.map((r) => r.address)).toEqual(["a@x.com"]);
    expect(page.has_more).toBe(true);
    expect(page.counts.hard_bounce).toBe(2);
    expect(page.counts.complaint).toBe(1);

    const next = await (
      await list("?reason=hard_bounce&limit=1&after=a@x.com")
    ).json<SuppressionPage>();

    expect(next.data.map((r) => r.address)).toEqual(["b@x.com"]);
    expect(next.has_more).toBe(false);
  });

  it("counts for the search, not for the reason", async () => {
    const res = await (
      await list("?q=x.com&reason=complaint")
    ).json<SuppressionPage>();

    expect(res.data.map((r) => r.address)).toEqual(["c@x.com"]);
    expect(res.counts).toEqual({ hard_bounce: 2, complaint: 1 });
  });

  it("refuses an unknown reason", async () => {
    const res = await list("?reason=spam");

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_parameter" });
  });
});

describe("dashboard suppressions batch add", () => {
  it("adds the new addresses and sends one event for each", async () => {
    await createWebhook(env, {
      endpoint: "https://hooks.example.com/suppressions",
      events: ["suppression.added"],
    });

    const sent = vi.spyOn(env.HOOKS_QUEUE, "sendBatch").mockResolvedValue(SENT);

    const res = await batch({
      // One address is on the list, and one comes twice.
      emails: [
        "New1@Example.com",
        "new2@example.com",
        "a@x.com",
        "new1@example.com",
      ],
      reason: "complaint",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 2, skipped: 1 });

    const types = sent.mock.calls.flatMap(([messages]) =>
      [...messages].map((m) => JSON.parse(m.body.body ?? "{}").type),
    );

    expect(types).toEqual(["suppression.added", "suppression.added"]);
    sent.mockRestore();

    const rows = await (await list("?q=example.com")).json<SuppressionPage>();

    expect(rows.data).toEqual([
      expect.objectContaining({
        address: "new1@example.com",
        reason: "complaint",
      }),
      expect.objectContaining({
        address: "new2@example.com",
        reason: "complaint",
      }),
    ]);

    // The old row keeps its reason.
    const old = await env.DB.prepare(
      "SELECT reason FROM suppressions WHERE address = 'a@x.com'",
    ).first<{ reason: string }>();

    expect(old?.reason).toBe("hard_bounce");
  });

  it("uses manual when no reason is given", async () => {
    expect((await batch({ emails: ["plain@example.com"] })).status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT reason, source FROM suppressions WHERE address = 'plain@example.com'",
    ).first<{ reason: string; source: string }>();

    expect(row?.reason).toBe("manual");
    expect(row?.source).toMatch(/^dashboard:/);
  });

  it("refuses bad input", async () => {
    expect((await batch({})).status).toBe(422);
    expect((await batch({ emails: [] })).status).toBe(422);
    expect((await batch({ emails: ["not an address"] })).status).toBe(422);
    expect(
      (await batch({ emails: ["ok@example.com"], reason: "spam" })).status,
    ).toBe(422);

    const many = Array.from({ length: 101 }, (_, i) => `many${i}@example.com`);

    expect((await batch({ emails: many })).status).toBe(422);

    const noHeader = await call("/api/suppressions/batch", {
      method: "POST",
      headers: { Cookie: headers.Cookie! },
      body: JSON.stringify({ emails: ["x@example.com"] }),
    });

    expect(noHeader.status).toBe(400);
  });

  it("reads the webhooks once and sends one queue batch", async () => {
    await env.DB.prepare("DELETE FROM webhooks").run();
    await createWebhook(env, {
      endpoint: "https://hooks.example.com/bulk",
      events: ["suppression.added", "suppression.removed"],
    });

    const sent = vi.spyOn(env.HOOKS_QUEUE, "sendBatch").mockResolvedValue(SENT);
    const real = env.DB.prepare.bind(env.DB);
    let hookReads = 0;

    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("FROM webhooks WHERE status = 'enabled'")) hookReads++;

      return real(sql);
    });

    try {
      const emails = Array.from(
        { length: 6 },
        (_, i) => `bulk${i}@example.com`,
      );

      expect((await batch({ emails })).status).toBe(200);

      const removed = await call("/api/suppressions/bulk0%40example.com", {
        method: "DELETE",
        headers,
      });

      expect(removed.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    // One read for the six adds, one for the remove.
    expect(hookReads).toBe(2);
    expect(sent).toHaveBeenCalledTimes(2);
    expect([...sent.mock.calls[0]![0]]).toHaveLength(6);
    sent.mockRestore();
  });
});
