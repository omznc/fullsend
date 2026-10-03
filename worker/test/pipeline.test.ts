import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { SuppressionAddedEvent } from "resend";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  dispatchScheduled,
  retention,
  STUCK_AFTER,
  sweepStuck,
} from "../src/cron";
import type { Env, HookMessage, SendMessage } from "../src/env";
import { handleEvent, handleEventsBatch } from "../src/events/consumer";
import { parseJsonText } from "../src/lib/json";
import { setSettings } from "../src/lib/settings";
import { logSystemEvent } from "../src/lib/system-events";
import { handleSendBatch } from "../src/send/consumer";
import { createEmail } from "../src/send/create";
import { cancelEmail } from "../src/send/manage";
import { signLink } from "../src/tracking/sign";
import { deliver, handleHooksBatch } from "../src/webhooks/deliver";
import { createWebhook } from "../src/webhooks/service";
import { addDomain, call } from "./helpers";

// The suppression.added body. The type of the SDK checks the schema.
const suppressionAdded = z.object({
  type: z.literal("suppression.added"),
  created_at: z.string(),
  data: z.object({
    id: z.string(),
    email: z.string(),
    origin: z.enum(["bounce", "complaint", "manual"]),
    source_id: z.string().nullable(),
    created_at: z.string(),
  }),
});

// The reply of a stub queue. fullsend does not read it.
const SENT: QueueSendBatchResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

// The tests call the consumers by hand. A stub queue keeps the real
// consumer from racing them.
const queueSpy = vi.spyOn(env.SEND_QUEUE, "sendBatch").mockResolvedValue(SENT);

beforeAll(async () => {
  await addDomain("send.example.com");

  // Use setSettings: it clears the settings cache of the Worker. Any
  // request to the Worker before this point fills the cache, and a raw SQL
  // insert leaves the old value there for 30 seconds.
  await setSettings(env, { tracking_hostname: "t.example.com" });
});

function fakeEnv(
  send: (m: EmailMessageBuilder) => Promise<EmailSendResult>,
): Env {
  // SAFETY: the stub implements the builder form of `send`. The send
  // consumer calls only that form.
  return { ...env, EMAIL: { send } as SendEmail };
}

async function runSend(e: Env, emailId: string, attempts = 1) {
  const batch = createMessageBatch<SendMessage>("fullsend-send", [
    { id: "m1", timestamp: new Date(), attempts, body: { emailId } },
  ]);

  const ctx = createExecutionContext();
  await handleSendBatch(batch, e);

  return getQueueResult(batch, ctx);
}

async function status(id: string) {
  return env.DB.prepare(
    "SELECT status, last_event, cf_message_id, error FROM emails WHERE id = ?",
  )
    .bind(id)
    .first<{
      status: string;
      last_event: string;
      cf_message_id: string | null;
      error: string | null;
    }>();
}

describe("send consumer", () => {
  it("sends through the binding and adds tracking", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "Acme <a@send.example.com>",
        to: ["x@example.net"],
        subject: "s",
        html: '<a href="https://example.com/p?a=1&amp;b=2">x</a></body>',
      },
      { apiKeyId: "test" },
    );

    const sent: EmailMessageBuilder[] = [];

    const result = await runSend(
      fakeEnv(async (m) => (sent.push(m), { messageId: "cf-1" })),
      id,
    );

    expect(result.explicitAcks).toContain("m1");
    expect(sent[0]!.from).toEqual({
      name: "Acme",
      email: "a@send.example.com",
    });
    expect(sent[0]!.html).toContain(`https://t.example.com/t/o/${id}`);
    expect(sent[0]!.html).toContain(
      `https://t.example.com/t/c/${id}?u=${encodeURIComponent("https://example.com/p?a=1&b=2")}`,
    );
    expect(await status(id)).toMatchObject({
      status: "sent",
      last_event: "sent",
      cf_message_id: "cf-1",
    });
  });

  it("fails at once on a permanent error", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    const err = Object.assign(new Error("sender not verified"), {
      code: "E_SENDER_NOT_VERIFIED",
    });

    const result = await runSend(
      fakeEnv(() => Promise.reject(err)),
      id,
    );

    expect(result.explicitAcks).toContain("m1");
    expect(await status(id)).toMatchObject({
      status: "failed",
      error: "sender not verified",
    });
  });

  it("retries a temporary error, then fails", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    const err = Object.assign(new Error("slow down"), {
      code: "E_RATE_LIMIT_EXCEEDED",
    });

    const first = await runSend(
      fakeEnv(() => Promise.reject(err)),
      id,
      1,
    );

    expect(
      first.retryMessages.map((m: { msgId: string }) => m.msgId),
    ).toContain("m1");
    expect((await status(id))?.status).toBe("queued");

    const last = await runSend(
      fakeEnv(() => Promise.reject(err)),
      id,
      5,
    );

    expect(last.explicitAcks).toContain("m1");
    expect((await status(id))?.status).toBe("failed");
  });

  it("sends one time when the queue delivers the message two times", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    let sends = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));

    const e = fakeEnv(async () => {
      sends++;
      await gate;

      return { messageId: "cf-dup" };
    });

    const first = runSend(e, id);
    // The second copy arrives while the first copy is in EMAIL.send.
    await vi.waitFor(() => expect(sends).toBe(1));
    const second = await runSend(e, id);
    expect(second.retryMessages).toHaveLength(1);
    open();
    await first;
    expect(sends).toBe(1);
    // The retried copy finds the sent email and does nothing.
    await runSend(e, id, 2);
    expect(sends).toBe(1);
    expect((await status(id))?.status).toBe("sent");
  });

  it("does not send again when the sent event failed", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    // Cloudflare accepted the email, then the consumer died.
    await env.DB.prepare(
      "UPDATE emails SET cf_message_id = 'cf-partial', sent_at = ? WHERE id = ?",
    )
      .bind(Date.now(), id)
      .run();
    let sends = 0;

    const result = await runSend(
      fakeEnv(async () => (sends++, { messageId: "cf-other" })),
      id,
      2,
    );

    expect(sends).toBe(0);
    expect(result.explicitAcks).toContain("m1");
    expect(await status(id)).toMatchObject({
      status: "sent",
      cf_message_id: "cf-partial",
    });
  });

  it("fails the email when an unexpected error repeats", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    const broken = fakeEnv(async () => ({ messageId: "never" }));

    const get = vi
      .spyOn(env.BODIES, "get")
      .mockRejectedValue(new Error("R2 is down"));

    try {
      const early = await runSend(broken, id, 1);
      expect(early.retryMessages).toHaveLength(1);
      expect((await status(id))?.status).toBe("queued");
      const last = await runSend(broken, id, 5);
      expect(last.explicitAcks).toContain("m1");
    } finally {
      get.mockRestore();
    }

    expect(await status(id)).toMatchObject({ status: "failed" });
    expect((await status(id))?.error).toContain("R2 is down");
  });
});

describe("events consumer", () => {
  it("applies Cloudflare events and suppresses a hard bounce", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: ["ok@example.net", "bad@example.net"],
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    await runSend(
      fakeEnv(async () => ({ messageId: "cf-events" })),
      id,
    );

    const base = {
      source: { type: "email.sending", domain: "send.example.com" },
    };

    expect(
      await handleEvent(env, {
        ...base,
        type: "cf.email.sending.message.delivered",
        payload: {
          eventId: "e1",
          messageId: "cf-events",
          recipient: "ok@example.net",
          delivery: { status: "delivered" },
        },
      }),
    ).toBe(true);
    expect((await status(id))?.status).toBe("delivered");

    await handleEvent(env, {
      ...base,
      type: "cf.email.sending.message.bounced",
      payload: {
        eventId: "e2",
        messageId: "cf-events",
        recipient: "Bad@example.net",
        bounce: { type: "hard", reason: "550 5.1.1 User unknown" },
      },
    });
    expect(await status(id)).toMatchObject({
      status: "bounced",
      error: "550 5.1.1 User unknown",
    });

    const sup = await env.DB.prepare(
      "SELECT reason FROM suppressions WHERE address = 'bad@example.net'",
    ).first();

    expect(sup).toEqual({ reason: "hard_bounce" });

    // A duplicate event changes nothing.
    await handleEvent(env, {
      ...base,
      type: "cf.email.sending.message.bounced",
      payload: {
        eventId: "e2",
        messageId: "cf-events",
        recipient: "bad@example.net",
      },
    });

    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM email_events WHERE email_id = ? AND type = 'bounced'",
    )
      .bind(id)
      .first<{ n: number }>();

    expect(n?.n).toBe(1);
  });

  it("finishes an event after a failed webhook fanout", async () => {
    await createWebhook(env, {
      endpoint: "https://hooks.example.com/bounce",
      events: ["email.bounced"],
    });

    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "retry@example.net",
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    await runSend(
      fakeEnv(async () => ({ messageId: "cf-retry" })),
      id,
    );

    const event = {
      type: "cf.email.sending.message.bounced",
      payload: {
        eventId: "e-retry",
        messageId: "cf-retry",
        recipient: "retry@example.net",
        bounce: { type: "hard" as const, reason: "550" },
      },
    };

    const hooks = vi
      .spyOn(env.HOOKS_QUEUE, "sendBatch")
      .mockRejectedValueOnce(new Error("queue down"));

    await expect(handleEvent(env, event)).rejects.toThrow("queue down");
    hooks.mockClear();
    hooks.mockResolvedValue(SENT);
    expect(await handleEvent(env, event)).toBe(true);
    expect(hooks).toHaveBeenCalledTimes(1);

    const sup = await env.DB.prepare(
      "SELECT reason FROM suppressions WHERE address = 'retry@example.net'",
    ).first();

    expect(sup).toEqual({ reason: "hard_bounce" });
    // The event is done now. A third copy sends no webhook.
    hooks.mockClear();
    await handleEvent(env, event);
    expect(hooks).not.toHaveBeenCalled();
    hooks.mockRestore();
  });

  it("sends suppression.added once for a hard bounce", async () => {
    await createWebhook(env, {
      endpoint: "https://hooks.example.com/suppression",
      events: ["suppression.added"],
    });

    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "sup-hook@example.net",
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    await runSend(
      fakeEnv(async () => ({ messageId: "cf-sup" })),
      id,
    );

    const bounce = (eventId: string) => ({
      type: "cf.email.sending.message.bounced",
      payload: {
        eventId,
        messageId: "cf-sup",
        recipient: "Sup-Hook@example.net",
        bounce: { type: "hard" as const, reason: "550" },
      },
    });

    const hooks = vi
      .spyOn(env.HOOKS_QUEUE, "sendBatch")
      .mockResolvedValue(SENT);

    try {
      await handleEvent(env, bounce("e-sup-1"));

      // A message of an email event has no body. Only the suppression
      // event has one.
      const bodies = hooks.mock.calls.flatMap(([batch]) =>
        [...batch].flatMap((m) => m.body.body ?? []),
      );

      expect(bodies).toHaveLength(1);

      const event: SuppressionAddedEvent = suppressionAdded.parse(
        parseJsonText(bodies[0]!),
      );

      expect(event.data).toMatchObject({
        email: "sup-hook@example.net",
        origin: "bounce",
        source_id: id,
      });

      // Another event for the same address adds nothing and sends no
      // suppression event.
      hooks.mockClear();
      await handleEvent(env, bounce("e-sup-2"));

      expect(
        hooks.mock.calls.flatMap(([batch]) =>
          [...batch].flatMap((m) => m.body.body ?? []),
        ),
      ).toEqual([]);
    } finally {
      hooks.mockRestore();
    }
  });

  it("waits for an unknown message id", async () => {
    const done = await handleEvent(env, {
      type: "cf.email.sending.message.delivered",
      payload: { messageId: "not-yet", recipient: "x@example.net" },
    });

    expect(done).toBe(false);
  });
});

describe("webhook delivery", () => {
  it("posts a signed Resend body and stores the attempt", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/in",
      events: ["email.sent"],
    });

    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "hooked",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    await runSend(
      fakeEnv(async () => ({ messageId: "cf-hook" })),
      id,
    );

    const ev = await env.DB.prepare(
      "SELECT id FROM email_events WHERE email_id = ? AND type = 'sent'",
    )
      .bind(id)
      .first<{ id: string }>();

    const calls: Request[] = [];

    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        calls.push(new Request(input, init));

        return new Response("ok", { status: 200 });
      });

    const msg: HookMessage = {
      webhookId: hook.id,
      messageId: "msg_test",
      eventId: ev!.id,
      body: null,
    };

    const retry = await deliver(env, msg, 1);
    spy.mockRestore();

    expect(retry).toBe(false);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.headers.get("svix-id")).toBe("msg_test");
    expect(req.headers.get("svix-signature")).toMatch(/^v1,/);

    const body = await req.json<{
      type: string;
      data: { email_id: string; subject: string };
    }>();

    expect(body).toMatchObject({
      type: "email.sent",
      data: { email_id: id, subject: "hooked" },
    });

    const row = await env.DB.prepare(
      "SELECT status_code, attempt FROM webhook_deliveries WHERE webhook_id = ?",
    )
      .bind(hook.id)
      .first();

    expect(row).toEqual({ status_code: 200, attempt: 1 });
  });
});

describe("tracking", () => {
  it("serves the pixel and records an open", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        html: "<p>x</p>",
      },
      { apiKeyId: "test" },
    );

    const res = await call(`/t/o/${id}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    expect(res.headers.get("Content-Type")).toBe("image/gif");
    await vi.waitFor(async () => {
      const ev = await env.DB.prepare(
        "SELECT type, bot FROM email_events WHERE email_id = ? AND type = 'opened'",
      )
        .bind(id)
        .first();

      expect(ev).toEqual({ type: "opened", bot: null });
    });
  });

  it("redirects a signed click and refuses a bad signature", async () => {
    const url = "https://example.com/landing";
    const sig = await signLink("test-session-secret", "abc", url);

    const ok = await call(`/t/c/abc?u=${encodeURIComponent(url)}&s=${sig}`, {
      redirect: "manual",
    });

    expect(ok.status).toBe(302);
    expect(ok.headers.get("Location")).toBe(url);

    const bad = await call(
      `/t/c/abc?u=${encodeURIComponent("https://evil.example")}&s=${sig}`,
      { redirect: "manual" },
    );

    expect(bad.status).toBe(400);
  });

  it("serves only tracking links on the tracking hostname", async () => {
    const res = await fetchHost("t.example.com", "/emails");
    expect(res.status).toBe(404);
  });
});

async function fetchHost(host: string, path: string) {
  const { exports } = await import("cloudflare:workers");

  return exports.default.fetch(new Request(`https://${host}${path}`));
}

describe("cron", () => {
  it("puts due scheduled emails on the queue one time", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
        scheduled_at: new Date(Date.now() + 30_000).toISOString(),
      },
      { apiKeyId: "test" },
    );

    const spy = queueSpy;
    spy.mockClear();
    expect(await dispatchScheduled(env)).toBeGreaterThanOrEqual(1);
    const sent = spy.mock.calls.flatMap((c) => [...c[0]]);
    expect(
      sent.find((m) => m.body.emailId === id)?.delaySeconds,
    ).toBeGreaterThan(0);
    spy.mockClear();
    await dispatchScheduled(env);
    expect(
      spy.mock.calls
        .flatMap((c) => [...c[0]])
        .some((m) => m.body.emailId === id),
    ).toBe(false);
  });
  it("puts the emails back when the queue fails", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
        scheduled_at: new Date(Date.now() + 20_000).toISOString(),
      },
      { apiKeyId: "test" },
    );

    queueSpy.mockRejectedValueOnce(new Error("queue down"));
    await dispatchScheduled(env);

    const row = await env.DB.prepare(
      "SELECT dispatched_at FROM emails WHERE id = ?",
    )
      .bind(id)
      .first<{ dispatched_at: number | null }>();

    expect(row?.dispatched_at).toBeNull();
    queueSpy.mockClear();
    await dispatchScheduled(env);
    expect(
      queueSpy.mock.calls
        .flatMap((c) => [...c[0]])
        .some((m) => m.body.emailId === id),
    ).toBe(true);
  });

  it("keeps a scheduled email in retention", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
        scheduled_at: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      },
      { apiKeyId: "test" },
    );

    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('body_retention_days', '1'), ('row_retention_days', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run();
    await retention(env, Date.now() + 3 * 86_400_000);

    const row = await env.DB.prepare(
      "SELECT status, body_key FROM emails WHERE id = ?",
    )
      .bind(id)
      .first<{ status: string; body_key: string | null }>();

    expect(row?.status).toBe("scheduled");
    expect(row?.body_key).not.toBeNull();
    await cancelEmail(env, id);
  });
});

describe("stuck email sweep", () => {
  const old = () => Date.now() - STUCK_AFTER - 60_000;

  async function queued() {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    return id;
  }

  const set = (id: string, sql: string, ...args: (number | string)[]) =>
    env.DB.prepare(`UPDATE emails SET ${sql} WHERE id = ?`)
      .bind(...args, id)
      .run();

  const queuedIds = () =>
    queueSpy.mock.calls.flatMap((c) => [...c[0]].map((m) => m.body.emailId));

  const eventTypes = async (id: string) =>
    (
      await env.DB.prepare(
        "SELECT type FROM email_events WHERE email_id = ? ORDER BY created_at",
      )
        .bind(id)
        .all<{ type: string }>()
    ).results.map((r) => r.type);

  it("records the sent event without a second send", async () => {
    const id = await queued();
    // Cloudflare accepted the email long ago, but the event is lost.
    await set(id, "cf_message_id = 'cf-lost', sent_at = ?", old());
    queueSpy.mockClear();

    expect((await sweepStuck(env)).recorded).toBeGreaterThanOrEqual(1);
    expect(queuedIds()).toContain(id);

    // The queue delivers the message to the consumer.
    let sends = 0;

    const result = await runSend(
      fakeEnv(async () => (sends++, { messageId: "cf-second" })),
      id,
    );

    expect(sends).toBe(0);
    expect(result.explicitAcks).toContain("m1");
    expect(await status(id)).toMatchObject({
      status: "sent",
      cf_message_id: "cf-lost",
    });
    expect(await eventTypes(id)).toContain("sent");

    // The sent email is not swept again.
    queueSpy.mockClear();
    await sweepStuck(env);
    expect(queuedIds()).not.toContain(id);
  });

  it("puts a lost email back 3 times, then fails it", async () => {
    const id = await queued();
    await set(id, "created_at = ?", old());

    for (let n = 1; n <= 3; n++) {
      queueSpy.mockClear();
      await sweepStuck(env);
      expect(queuedIds()).toContain(id);

      const row = await env.DB.prepare(
        "SELECT sweep_count FROM emails WHERE id = ?",
      )
        .bind(id)
        .first<{ sweep_count: number }>();

      expect(row?.sweep_count).toBe(n);
      // The sweep marks the time, so the next minute does not repeat it.
      queueSpy.mockClear();
      await sweepStuck(env);
      expect(queuedIds()).not.toContain(id);
      await set(id, "dispatched_at = ?", old());
    }

    queueSpy.mockClear();
    const result = await sweepStuck(env);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(queuedIds()).not.toContain(id);
    expect((await status(id))?.status).toBe("failed");
    expect(await eventTypes(id)).toContain("failed");
  });

  it("keeps the row when the queue fails", async () => {
    const id = await queued();
    await set(id, "created_at = ?", old());
    queueSpy.mockRejectedValueOnce(new Error("queue down"));
    await sweepStuck(env);

    const row = await env.DB.prepare(
      "SELECT status, sweep_count FROM emails WHERE id = ?",
    )
      .bind(id)
      .first<{ status: string; sweep_count: number }>();

    expect(row).toEqual({ status: "queued", sweep_count: 0 });
    queueSpy.mockClear();
    await sweepStuck(env);
    expect(queuedIds()).toContain(id);
  });

  it("fails an old claim and never puts it back", async () => {
    const id = await queued();
    await set(id, "claimed_at = ?", old());
    queueSpy.mockClear();

    expect((await sweepStuck(env)).uncertain).toBeGreaterThanOrEqual(1);
    expect(queuedIds()).not.toContain(id);
    expect(await status(id)).toMatchObject({ status: "failed" });
    expect((await status(id))?.error).toContain("Check before you send");
    expect(await eventTypes(id)).toContain("failed");

    const logged = await env.DB.prepare(
      "SELECT level, detail FROM system_events WHERE source = 'sweep' AND level = 'error' AND detail LIKE ?",
    )
      .bind(`%${id}%`)
      .first<{ level: string; detail: string }>();

    expect(logged).not.toBeNull();
  });

  it("leaves a recent email alone", async () => {
    const id = await queued();
    queueSpy.mockClear();
    await sweepStuck(env);
    expect(queuedIds()).not.toContain(id);
    expect((await status(id))?.status).toBe("queued");
  });
});

describe("failure handling", () => {
  it("acks a message that cannot get the claim at max attempts", async () => {
    const { id } = await createEmail(
      env,
      {
        from: "a@send.example.com",
        to: "x@example.net",
        subject: "s",
        text: "t",
      },
      { apiKeyId: "test" },
    );

    await env.DB.prepare("UPDATE emails SET claimed_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();

    const e = fakeEnv(async () => ({ messageId: "never" }));
    expect((await runSend(e, id, 4)).retryMessages).toHaveLength(1);

    const last = await runSend(e, id, 5);
    expect(last.explicitAcks).toContain("m1");
    expect(last.retryMessages).toHaveLength(0);
    expect((await status(id))?.status).toBe("queued");
  });

  it("records a failed event when the enqueue fails", async () => {
    queueSpy.mockRejectedValueOnce(new Error("queue down"));

    await expect(
      createEmail(
        env,
        {
          from: "a@send.example.com",
          to: "enqueue-fail@example.net",
          subject: "enqueue-fail",
          text: "t",
        },
        { apiKeyId: "test" },
      ),
    ).rejects.toThrow("queue down");

    const row = await env.DB.prepare(
      "SELECT id, status FROM emails WHERE subject = 'enqueue-fail'",
    ).first<{ id: string; status: string }>();

    expect(row?.status).toBe("failed");

    const ev = await env.DB.prepare(
      "SELECT type FROM email_events WHERE email_id = ? AND type = 'failed'",
    )
      .bind(row?.id ?? "")
      .first();

    expect(ev).not.toBeNull();

    const sys = await env.DB.prepare(
      "SELECT level FROM system_events WHERE source = 'send' AND message LIKE 'The enqueue failed%'",
    ).first<{ level: string }>();

    expect(sys?.level).toBe("error");
  });

  it("does not throw when the system event insert fails", async () => {
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
      throw new Error("D1 is down");
    });

    try {
      await expect(
        logSystemEvent(env, { level: "warn", source: "test", message: "m" }),
      ).resolves.toBeUndefined();
    } finally {
      prepare.mockRestore();
    }
  });
});

// Makes the D1 binding fail for each statement that contains `text`.
function failStatements(text: string, times = Infinity) {
  const real = env.DB.prepare.bind(env.DB);
  let left = times;

  return vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    if (sql.includes(text) && left-- > 0) throw new Error("D1 is down");

    return real(sql);
  });
}

const countEvents = async (source: string, level: string) =>
  (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM system_events WHERE source = ? AND level = ?",
    )
      .bind(source, level)
      .first<{ n: number }>()
  )?.n ?? 0;

async function plainEmail(subject: string) {
  const { id } = await createEmail(
    env,
    { from: "a@send.example.com", to: "x@example.net", subject, text: "t" },
    { apiKeyId: "test" },
  );

  return id;
}

describe("post-send write", () => {
  it("keeps the claim and does not retry when the write fails", async () => {
    const id = await plainEmail("store-fails");
    const before = await countEvents("send", "error");
    const spy = failStatements("SET cf_message_id");
    let sends = 0;

    const result = await runSend(
      fakeEnv(async () => (sends++, { messageId: "cf-lost" })),
      id,
    );

    spy.mockRestore();
    expect(sends).toBe(1);
    expect(result.explicitAcks).toContain("m1");
    expect(result.retryMessages).toHaveLength(0);

    const row = await env.DB.prepare(
      "SELECT status, cf_message_id, claimed_at FROM emails WHERE id = ?",
    )
      .bind(id)
      .first<{
        status: string;
        cf_message_id: string | null;
        claimed_at: number | null;
      }>();

    expect(row?.status).toBe("queued");
    expect(row?.cf_message_id).toBeNull();
    expect(row?.claimed_at).not.toBeNull();
    expect(await countEvents("send", "error")).toBe(before + 1);

    const ev = await env.DB.prepare(
      "SELECT detail FROM system_events WHERE source = 'send' ORDER BY created_at DESC LIMIT 1",
    ).first<{ detail: string }>();

    expect(JSON.parse(ev!.detail)).toMatchObject({
      emailId: id,
      cfMessageId: "cf-lost",
    });

    // A second copy of the message cannot take the email.
    const again = await runSend(
      fakeEnv(async () => (sends++, { messageId: "cf-twice" })),
      id,
    );

    expect(sends).toBe(1);
    expect(again.retryMessages).toHaveLength(1);
  });

  it("stores the id when a later try works", async () => {
    const id = await plainEmail("store-retries");
    const spy = failStatements("SET cf_message_id", 1);

    const result = await runSend(
      fakeEnv(async () => ({ messageId: "cf-late" })),
      id,
    );

    spy.mockRestore();
    expect(result.explicitAcks).toContain("m1");
    expect(await status(id)).toMatchObject({
      status: "sent",
      cf_message_id: "cf-late",
    });
  });
});

describe("dead letters", () => {
  const eventBody = {
    type: "cf.email.sending.message.delivered",
    payload: { messageId: "cf-dead", recipient: "secret@example.net" },
  };

  async function runEvents(bodies: { body: unknown; attempts: number }[]) {
    const batch = createMessageBatch(
      "fullsend-events",
      bodies.map((b, i) => ({
        id: `e${i}`,
        timestamp: new Date(),
        attempts: b.attempts,
        body: b.body,
      })),
    );

    const ctx = createExecutionContext();
    await handleEventsBatch(batch, env);

    return getQueueResult(batch, ctx);
  }

  it("retries an event that fails, then stores its payload", async () => {
    const spy = failStatements("WHERE cf_message_id = ?");
    const first = await runEvents([{ body: eventBody, attempts: 9 }]);
    expect(first.retryMessages).toHaveLength(1);

    const last = await runEvents([{ body: eventBody, attempts: 10 }]);
    spy.mockRestore();
    expect(last.explicitAcks).toContain("e0");
    expect(last.retryMessages).toHaveLength(0);

    const ev = await env.DB.prepare(
      "SELECT level, detail FROM system_events WHERE source = 'events' AND level = 'error'",
    ).first<{ level: string; detail: string }>();

    expect(JSON.parse(ev!.detail).payload).toEqual(eventBody);
  });

  it("logs a dropped event without the recipient", async () => {
    const result = await runEvents([
      {
        body: {
          ...eventBody,
          payload: { ...eventBody.payload, messageId: "cf-never" },
        },
        attempts: 8,
      },
    ]);

    expect(result.explicitAcks).toContain("e0");

    const ev = await env.DB.prepare(
      "SELECT detail FROM system_events WHERE source = 'events' AND level = 'warn'",
    ).first<{ detail: string }>();

    expect(JSON.parse(ev!.detail)).toEqual({
      cfMessageId: "cf-never",
      type: "cf.email.sending.message.delivered",
    });
  });

  it("reads the webhooks one time for a batch", async () => {
    const ids = [await plainEmail("batch-1"), await plainEmail("batch-2")];

    for (const [i, id] of ids.entries())
      await runSend(
        fakeEnv(async () => ({ messageId: `cf-batch-${i}` })),
        id,
      );

    const real = env.DB.prepare.bind(env.DB);
    let reads = 0;

    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("FROM webhooks WHERE status")) reads++;

      return real(sql);
    });

    const event = (n: number, kind: string) => ({
      body: {
        type: `cf.email.sending.message.${kind}`,
        payload: { messageId: `cf-batch-${n}`, recipient: "x@example.net" },
      },
      attempts: 1,
    });

    const result = await runEvents([
      event(0, "delivered"),
      event(1, "delivered"),
      event(0, "bounced"),
    ]);

    spy.mockRestore();
    expect(result.explicitAcks).toHaveLength(3);
    expect(reads).toBe(1);
    expect((await status(ids[0]!))?.status).toBe("bounced");
    expect((await status(ids[1]!))?.status).toBe("delivered");
  });

  async function runHooks(body: HookMessage, attempts: number) {
    const batch = createMessageBatch<HookMessage>("fullsend-hooks", [
      { id: "h1", timestamp: new Date(), attempts, body },
    ]);

    const ctx = createExecutionContext();
    await handleHooksBatch(batch, env);

    return getQueueResult(batch, ctx);
  }

  it("stores a webhook message that fails after the last retry", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/dead",
      events: ["email.sent"],
    });

    // The body is not JSON, so deliver throws.
    const msg: HookMessage = {
      webhookId: hook.id,
      messageId: "msg_dead",
      eventId: null,
      body: "not json",
    };

    expect((await runHooks(msg, 7)).retryMessages).toHaveLength(1);

    const last = await runHooks(msg, 8);
    expect(last.explicitAcks).toContain("h1");
    expect(last.retryMessages).toHaveLength(0);

    const ev = await env.DB.prepare(
      "SELECT detail FROM system_events WHERE source = 'hooks' AND level = 'error'",
    ).first<{ detail: string }>();

    expect(JSON.parse(ev!.detail)).toMatchObject({
      webhookId: hook.id,
      payload: { messageId: "msg_dead" },
    });
  });

  it("logs a warning when the last delivery fails", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/down",
      events: ["email.sent"],
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("no", { status: 500 }));

    const msg: HookMessage = {
      webhookId: hook.id,
      messageId: "msg_down",
      eventId: null,
      body: JSON.stringify({ type: "email.sent" }),
    };

    const early = await runHooks(msg, 7);
    expect(early.retryMessages).toHaveLength(1);
    expect(await countEvents("hooks", "warn")).toBe(0);

    const last = await runHooks(msg, 8);
    fetchSpy.mockRestore();
    expect(last.explicitAcks).toContain("h1");

    const ev = await env.DB.prepare(
      "SELECT detail FROM system_events WHERE source = 'hooks' AND level = 'warn'",
    ).first<{ detail: string }>();

    expect(JSON.parse(ev!.detail)).toMatchObject({
      webhookId: hook.id,
      eventType: "email.sent",
    });
  });
});

describe("retention", () => {
  const setDays = (body: number, row: number) =>
    env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('body_retention_days', ?1), ('row_retention_days', ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(String(body), String(row))
      .run();

  async function bodyKey(id: string) {
    const row = await env.DB.prepare("SELECT body_key FROM emails WHERE id = ?")
      .bind(id)
      .first<{ body_key: string }>();

    return row!.body_key;
  }

  it("deletes the body with an old row when rows expire first", async () => {
    const id = await plainEmail("retention-r2");
    const key = await bodyKey(id);
    expect(await env.BODIES.get(key)).not.toBeNull();
    await env.DB.prepare("UPDATE emails SET status = 'sent' WHERE id = ?")
      .bind(id)
      .run();

    // The rows expire after 1 day, the bodies after 30 days.
    await setDays(30, 1);
    await retention(env, Date.now() + 3 * 86_400_000);

    expect(await env.BODIES.get(key)).toBeNull();

    const row = await env.DB.prepare("SELECT id FROM emails WHERE id = ?")
      .bind(id)
      .first();

    expect(row).toBeNull();
  });

  it("deletes an old body and keeps the row", async () => {
    const id = await plainEmail("retention-body");
    const key = await bodyKey(id);
    await env.DB.prepare("UPDATE emails SET status = 'sent' WHERE id = ?")
      .bind(id)
      .run();

    await setDays(1, 30);
    await retention(env, Date.now() + 3 * 86_400_000);

    expect(await env.BODIES.get(key)).toBeNull();
    expect(
      await env.DB.prepare("SELECT body_key FROM emails WHERE id = ?")
        .bind(id)
        .first(),
    ).toEqual({ body_key: null });
  });

  it("keeps a pending email and its body", async () => {
    const id = await plainEmail("retention-pending");
    const key = await bodyKey(id);
    await env.DB.prepare("UPDATE emails SET created_at = 1 WHERE id = ?")
      .bind(id)
      .run();

    await setDays(1, 1);
    await retention(env, Date.now() + 90 * 86_400_000);

    expect((await status(id))?.status).toBe("queued");
    expect(await env.BODIES.get(key)).not.toBeNull();
  });

  it("cleans a large table in more than one chunk", async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `old-${i}`);
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO api_requests (id, created_at, method, path, status, duration_ms)
       SELECT value, ?2, 'GET', '/old', 200, 1 FROM json_each(?1)`,
    )
      .bind(JSON.stringify(ids), now - 15 * 86_400_000)
      .run();
    await env.DB.prepare(
      "INSERT INTO api_requests (id, created_at, method, path, status, duration_ms) VALUES ('recent', ?, 'GET', '/recent', 200, 1)",
    )
      .bind(now - 86_400_000)
      .run();

    const real = env.DB.prepare.bind(env.DB);
    let deletes = 0;

    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("DELETE FROM api_requests")) deletes++;

      return real(sql);
    });

    const result = await retention(env, now);
    spy.mockRestore();

    expect(result.complete).toBe(true);
    expect(deletes).toBe(3);

    const left = await env.DB.prepare(
      "SELECT path FROM api_requests ORDER BY path",
    ).all<{ path: string }>();

    expect(left.results).toEqual([{ path: "/recent" }]);
  });

  it("deletes old system events and keeps recent ones", async () => {
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO system_events (id, created_at, level, source, message) VALUES
       ('se-old', ?1, 'warn', 'retention-test', 'old'),
       ('se-new', ?2, 'warn', 'retention-test', 'new')`,
    )
      .bind(now - 31 * 86_400_000, now - 86_400_000)
      .run();
    await retention(env, now);

    const left = await env.DB.prepare(
      "SELECT id FROM system_events WHERE source = 'retention-test'",
    ).all<{ id: string }>();

    expect(left.results).toEqual([{ id: "se-new" }]);
  });
});
