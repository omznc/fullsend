import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createWebhook } from "../src/webhooks/service";
import { call, dashSession } from "./helpers";

let headers: Record<string, string>;

beforeAll(async () => {
  headers = await dashSession();
});

interface Patch {
  endpoint?: string;
  events?: string[];
  secret?: string;
  status?: "enabled" | "disabled";
}

const patch = (id: string, body: Patch) =>
  call(`/api/webhooks/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });

describe("dashboard webhook edit", () => {
  it("changes the endpoint and the events, not the secret", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/old",
      events: ["email.sent"],
    });

    const res = await patch(hook.id, {
      endpoint: "https://hooks.example.com/new",
      events: ["email.bounced", "email.delivered"],
      // A secret in the body is ignored.
      secret: "whsec_other",
    });

    expect(res.status).toBe(200);

    const detail = await (
      await call(`/api/webhooks/${hook.id}`, { headers })
    ).json<{
      endpoint: string;
      events: string[];
      signing_secret: string;
      available_events: string[];
    }>();

    expect(detail.endpoint).toBe("https://hooks.example.com/new");
    expect(detail.events).toEqual(["email.bounced", "email.delivered"]);
    expect(detail.signing_secret).toBe(hook.secret);
    expect(detail.available_events).toContain("email.sent");
  });

  it("refuses a bad endpoint and an unknown event", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/keep",
      events: ["email.sent"],
    });

    expect((await patch(hook.id, { endpoint: "ftp://x.example" })).status).toBe(
      422,
    );
    expect((await patch(hook.id, { events: ["email.nope"] })).status).toBe(422);
    expect((await patch(hook.id, { events: [] })).status).toBe(422);

    const after = await (
      await call(`/api/webhooks/${hook.id}`, { headers })
    ).json<{ endpoint: string; events: string[] }>();

    expect(after.endpoint).toBe("https://hooks.example.com/keep");
    expect(after.events).toEqual(["email.sent"]);
  });

  it("needs the dashboard header", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/csrf",
      events: ["email.sent"],
    });

    const res = await call(`/api/webhooks/${hook.id}`, {
      method: "PATCH",
      headers: { Cookie: headers.Cookie! },
      body: JSON.stringify({ endpoint: "https://hooks.example.com/x" }),
    });

    expect(res.status).toBe(400);
  });
});

interface Seed {
  message: string;
  attempt: number;
  status: number | null;
  // Milliseconds before now.
  ago: number;
  type?: string;
}

// Inserts delivery rows for a webhook. The id of a row is its message id
// and its attempt.
async function seed(hookId: string, rows: Seed[]) {
  const now = Date.now();

  const insert = env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, webhook_id, message_id, event_id, event_type, attempt,
       status_code, duration_ms, request_body, response_excerpt, error, created_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, 10, ?7, NULL, ?8, ?9)`,
  );

  await env.DB.batch(
    rows.map((r) =>
      insert.bind(
        `${r.message}-${r.attempt}-${r.ago}`,
        hookId,
        r.message,
        r.type ?? "email.bounced",
        r.attempt,
        r.status,
        JSON.stringify({ type: r.type ?? "email.bounced", data: {} }),
        r.status === null ? "timeout" : null,
        now - r.ago,
      ),
    ),
  );
}

// The reply of a stub queue. fullsend does not read it.
const SENT: QueueSendBatchResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

const HOUR = 3_600_000;

interface ResendBody {
  since?: string;
}

interface DeliveryPage {
  has_more: boolean;
  data: {
    id: string;
    message_id: string;
    ok: boolean;
    created_at: string;
    max_attempts: number;
    next_attempt_at: string | null;
  }[];
}

const deliveries = (id: string, query = "") =>
  call(`/api/webhooks/${id}/deliveries${query}`, { headers });

describe("dashboard webhook deliveries", () => {
  it("filters by result and by event type", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/filter",
      events: ["email.sent"],
    });

    await seed(hook.id, [
      { message: "f-ok", attempt: 1, status: 200, ago: 4 * HOUR },
      { message: "f-500", attempt: 1, status: 500, ago: 3 * HOUR },
      {
        message: "f-timeout",
        attempt: 1,
        status: null,
        ago: 2 * HOUR,
        type: "email.sent",
      },
    ]);

    const ids = async (query: string) =>
      (await (await deliveries(hook.id, query)).json<DeliveryPage>()).data.map(
        (d) => d.message_id,
      );

    expect(await ids("")).toEqual(["f-timeout", "f-500", "f-ok"]);
    expect(await ids("?ok=true")).toEqual(["f-ok"]);
    // A call with no answer failed too.
    expect(await ids("?ok=false")).toEqual(["f-timeout", "f-500"]);
    expect(await ids("?event_type=email.sent")).toEqual(["f-timeout"]);
    expect(await ids("?ok=false&event_type=email.bounced")).toEqual(["f-500"]);
    expect((await deliveries(hook.id, "?ok=maybe")).status).toBe(422);
  });

  it("says when the next attempt runs", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/next",
      events: ["email.sent"],
    });

    await seed(hook.id, [
      // A failed attempt with a retry due.
      { message: "n-retry", attempt: 1, status: 500, ago: 1000 },
      // An attempt that a later attempt replaced.
      { message: "n-later", attempt: 1, status: 500, ago: 5000 },
      { message: "n-later", attempt: 2, status: 200, ago: 1000 },
      // The last attempt: no delay is left.
      { message: "n-last", attempt: 8, status: 500, ago: 1000 },
    ]);

    const page = await (await deliveries(hook.id)).json<DeliveryPage>();

    const next = (message: string, status?: boolean) =>
      page.data.find((d) => d.message_id === message && d.ok !== status)!;

    expect(page.data.every((d) => d.max_attempts === 8)).toBe(true);
    // The first retry comes 5 seconds after the failed attempt.
    const retry = next("n-retry");

    expect(
      Date.parse(retry.next_attempt_at!) - Date.parse(retry.created_at),
    ).toBe(5000);
    expect(next("n-later", true).next_attempt_at).toBeNull();
    expect(next("n-later", false).next_attempt_at).toBeNull();
    expect(next("n-last").next_attempt_at).toBeNull();

    const detail = await (
      await call(`/api/webhooks/${hook.id}`, { headers })
    ).json<{ retry_delays: number[]; max_attempts: number }>();

    expect(detail.max_attempts).toBe(detail.retry_delays.length + 1);

    // A webhook that is off sends no retry.
    await patch(hook.id, { status: "disabled" });
    const off = await (await deliveries(hook.id)).json<DeliveryPage>();

    expect(off.data.every((d) => d.next_attempt_at === null)).toBe(true);
  });

  const resend = (id: string, body: ResendBody) =>
    call(`/api/webhooks/${id}/deliveries/resend-failed`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  it("sends the failed events again since a time", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/again",
      events: ["email.sent"],
    });

    await seed(hook.id, [
      // Failed for good one hour ago: sent again.
      { message: "r-gave-up", attempt: 8, status: 500, ago: HOUR },
      // Failed for good three days ago: older than the time.
      { message: "r-old", attempt: 8, status: 500, ago: 72 * HOUR },
      // The queue still retries it.
      { message: "r-retrying", attempt: 3, status: 500, ago: HOUR },
      // A later attempt worked.
      { message: "r-fixed", attempt: 8, status: 500, ago: 2 * HOUR },
      { message: "r-fixed", attempt: 1, status: 200, ago: HOUR },
    ]);

    const sent = vi.spyOn(env.HOOKS_QUEUE, "sendBatch").mockResolvedValue(SENT);

    const noHeader = await call(
      `/api/webhooks/${hook.id}/deliveries/resend-failed`,
      {
        method: "POST",
        headers: { Cookie: headers.Cookie! },
        body: JSON.stringify({ since: new Date().toISOString() }),
      },
    );

    expect(noHeader.status).toBe(400);
    expect((await resend(hook.id, {})).status).toBe(422);
    expect((await resend(hook.id, { since: "not a date" })).status).toBe(422);
    expect(sent).not.toHaveBeenCalled();

    const since = new Date(Date.now() - 24 * HOUR).toISOString();
    const res = await resend(hook.id, { since });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: 1, more: false, limit: 500 });
    expect(sent).toHaveBeenCalledTimes(1);

    const batch = sent.mock.calls[0]![0];

    expect([...batch].map((m) => m.body)).toEqual([
      expect.objectContaining({
        webhookId: hook.id,
        messageId: "r-gave-up",
        body: expect.stringContaining("email.bounced"),
      }),
    ]);

    // A longer time reaches the old event too.
    sent.mockClear();

    const wide = await resend(hook.id, {
      since: new Date(Date.now() - 96 * HOUR).toISOString(),
    });

    expect(await wide.json()).toMatchObject({ queued: 2 });

    // A webhook that is off cannot send again.
    await patch(hook.id, { status: "disabled" });
    expect((await resend(hook.id, { since })).status).toBe(422);
    sent.mockRestore();
  });
});
