import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, dashSession, newKey } from "./helpers";

interface Overview {
  stats: { type: string; value: number }[];
  recent_failures: { id: string }[];
}

interface Totals {
  totals: { sent: number; bounced: number };
}

describe("ignored emails", () => {
  let headers: Record<string, string>;
  let token: string;

  async function email(id: string, status: string) {
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO emails (id, api_key_id, "from", "to", subject, status, last_event, last_event_at, created_at)
       VALUES (?, 'test', 'a@x.example', '["b@y.example"]', 's', ?, ?, ?, ?)`,
    )
      .bind(id, status, status, now, now)
      .run();

    for (const type of ["sent", status]) {
      await env.DB.prepare(
        "INSERT INTO email_events (id, email_id, type, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(`${id}-${type}`, id, type, now)
        .run();
    }
  }

  const post = (path: string, body?: { ids?: string[] }) =>
    call(`/api${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
    });

  const detail = async (id: string) =>
    (await call(`/api/emails/${id}`, { headers })).json<{
      ignored_at: string | null;
    }>();

  const overview = async () =>
    (await call("/api/overview?period=7d", { headers })).json<Overview>();

  const metrics = async () =>
    (
      await call("/emails/metrics", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json<Totals>();

  const bounced = (o: Overview) =>
    o.stats.find((s) => s.type === "bounced")?.value;

  beforeAll(async () => {
    headers = await dashSession();
    token = (await newKey()).token;
    await email("ig-bounced", "bounced");
    await email("ig-delivered", "delivered");
    await email("ig-failed", "failed");
  });

  it("sets and clears ignored_at", async () => {
    expect((await detail("ig-bounced")).ignored_at).toBeNull();

    expect((await post("/emails/ig-bounced/ignore")).status).toBe(200);
    // A second call keeps the first time and does not fail.
    const first = (await detail("ig-bounced")).ignored_at;

    expect(first).not.toBeNull();
    expect((await post("/emails/ig-bounced/ignore")).status).toBe(200);
    expect((await detail("ig-bounced")).ignored_at).toBe(first);

    const undo = await call("/api/emails/ig-bounced/ignore", {
      method: "DELETE",
      headers,
    });

    expect(undo.status).toBe(200);
    expect((await detail("ig-bounced")).ignored_at).toBeNull();
  });

  it("refuses a delivered email and a missing email", async () => {
    const res = await post("/emails/ig-delivered/ignore");

    expect(res.status).toBe(422);
    expect((await res.json<{ error: string }>()).error).toBe("not_ignorable");
    expect((await post("/emails/ig-none/ignore")).status).toBe(404);
  });

  it("removes an ignored email from the stats", async () => {
    const before = await overview();
    const totals = await metrics();

    expect(bounced(before)).toBeGreaterThanOrEqual(1);
    expect(before.recent_failures.map((f) => f.id)).toContain("ig-bounced");

    await post("/emails/ig-bounced/ignore");

    const after = await overview();

    expect(bounced(after)).toBe((bounced(before) ?? 0) - 1);
    expect(after.recent_failures.map((f) => f.id)).not.toContain("ig-bounced");
    expect((await metrics()).totals.bounced).toBe(totals.totals.bounced - 1);
    expect((await metrics()).totals.sent).toBe(totals.totals.sent - 1);

    await call("/api/emails/ig-bounced/ignore", { method: "DELETE", headers });
    expect(bounced(await overview())).toBe(bounced(before));
  });

  it("ignores many emails and skips the others", async () => {
    const res = await post("/emails/ignore", {
      ids: ["ig-bounced", "ig-failed", "ig-delivered", "ig-none"],
    });

    expect(res.status).toBe(200);
    expect((await res.json<{ ignored: number }>()).ignored).toBe(2);
    expect((await detail("ig-delivered")).ignored_at).toBeNull();
    expect((await post("/emails/ignore", { ids: [] })).status).toBe(422);
  });
});
