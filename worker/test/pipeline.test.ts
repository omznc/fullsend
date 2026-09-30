import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchScheduled, retention } from "../src/cron";
import type { Env, HookMessage, SendMessage } from "../src/env";
import { handleEvent } from "../src/events/consumer";
import { handleSendBatch } from "../src/send/consumer";
import { createEmail } from "../src/send/create";
import { cancelEmail } from "../src/send/manage";
import { signLink } from "../src/tracking/sign";
import { deliver } from "../src/webhooks/deliver";
import { createWebhook } from "../src/webhooks/service";
import { addDomain, call } from "./helpers";

// The reply of a stub queue. fullsend does not read it.
const SENT: QueueSendBatchResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

// The tests call the consumers by hand. A stub queue keeps the real
// consumer from racing them.
const queueSpy = vi.spyOn(env.SEND_QUEUE, "sendBatch").mockResolvedValue(SENT);

beforeAll(async () => {
  await addDomain("send.example.com");
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('tracking_hostname', 't.example.com')",
  ).run();
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
