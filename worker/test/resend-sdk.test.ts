import { env } from "cloudflare:workers";
import { Resend } from "resend";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDomain, BASE, newKey, routeFetchToWorker } from "./helpers";

// Runs the official resend SDK against the Worker, with no patch: only
// the base URL and the key change.

let restore: () => void;

let resend: Resend;

let domainId: string;

beforeAll(async () => {
  restore = routeFetchToWorker();
  domainId = await addDomain("mail.example.com");
  const { token } = await newKey();
  resend = new Resend(token, { baseUrl: BASE });
});

afterAll(() => restore());

describe("emails", () => {
  it("sends an email and reads it back", async () => {
    const { data, error } = await resend.emails.send({
      from: "Acme <hello@mail.example.com>",
      to: ["omar@example.net"],
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      replyTo: "support@example.com",
      tags: [{ name: "category", value: "welcome" }],
    });

    expect(error).toBeNull();
    expect(data?.id).toMatch(/^[0-9a-f-]{36}$/);

    const got = await resend.emails.get(data!.id);
    expect(got.error).toBeNull();
    expect(got.data).toMatchObject({
      object: "email",
      id: data!.id,
      from: "Acme <hello@mail.example.com>",
      to: ["omar@example.net"],
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      reply_to: ["support@example.com"],
      tags: [{ name: "category", value: "welcome" }],
    });
    expect(["queued", "sent"]).toContain(got.data!.last_event);

    const list = await resend.emails.list({ limit: 10 });
    expect(list.error).toBeNull();
    expect(list.data?.object).toBe("list");
    expect(list.data?.data.some((e) => e.id === data!.id)).toBe(true);
  });

  it("rejects an unverified sender domain with 403", async () => {
    const { error } = await resend.emails.send({
      from: "hello@unknown.example.org",
      to: "omar@example.net",
      subject: "x",
      text: "x",
    });

    expect(error).toMatchObject({ statusCode: 403, name: "validation_error" });
  });

  it("rejects a bad from address with 422", async () => {
    const { error } = await resend.emails.send({
      from: "not an address",
      to: "omar@example.net",
      subject: "x",
      text: "x",
    });

    expect(error).toMatchObject({
      statusCode: 422,
      name: "invalid_from_address",
    });
  });

  it("rejects a missing body", async () => {
    // @ts-expect-error: the SDK types need html, text or react.
    const { error } = await resend.emails.send({
      from: "a@mail.example.com",
      to: "omar@example.net",
      subject: "x",
    });

    expect(error).toMatchObject({ statusCode: 422, name: "validation_error" });
  });

  it("returns the first response for the same idempotency key", async () => {
    const payload = {
      from: "a@mail.example.com",
      to: "omar@example.net",
      subject: "idem",
      text: "x",
    };

    const first = await resend.emails.send(payload, {
      idempotencyKey: "order-1",
    });

    const second = await resend.emails.send(payload, {
      idempotencyKey: "order-1",
    });

    expect(first.data?.id).toBeDefined();
    expect(second.data?.id).toBe(first.data?.id);

    const other = await resend.emails.send(
      { ...payload, subject: "changed" },
      { idempotencyKey: "order-1" },
    );

    expect(other.error).toMatchObject({
      statusCode: 409,
      name: "invalid_idempotent_request",
    });
  });

  it("schedules, reschedules and cancels an email", async () => {
    const { data } = await resend.emails.send({
      from: "a@mail.example.com",
      to: "omar@example.net",
      subject: "later",
      text: "x",
      scheduledAt: "in 1 hour",
    });

    let got = await resend.emails.get(data!.id);
    expect(got.data?.last_event).toBe("scheduled");
    expect(got.data?.scheduled_at).not.toBeNull();

    const at = new Date(Date.now() + 2 * 3_600_000).toISOString();

    const updated = await resend.emails.update({
      id: data!.id,
      scheduledAt: at,
    });

    expect(updated.error).toBeNull();
    got = await resend.emails.get(data!.id);
    expect(got.data?.scheduled_at).toBe(at);

    const canceled = await resend.emails.cancel(data!.id);
    expect(canceled.data).toEqual({ object: "email", id: data!.id });
    got = await resend.emails.get(data!.id);
    expect(got.data?.last_event).toBe("canceled");

    const again = await resend.emails.cancel(data!.id);
    expect(again.error?.statusCode).toBe(422);
  });

  it("drops suppressed recipients", async () => {
    await env.DB.prepare(
      "INSERT INTO suppressions (address, reason, source, created_at) VALUES ('gone@example.net', 'hard_bounce', 'test', 0)",
    ).run();

    const { data } = await resend.emails.send({
      from: "a@mail.example.com",
      to: "Gone <gone@example.net>",
      subject: "x",
      text: "x",
    });

    const got = await resend.emails.get(data!.id);
    expect(got.data?.last_event).toBe("suppressed");
  });

  it("returns 404 for an unknown email", async () => {
    const { error } = await resend.emails.get(
      "00000000-0000-0000-0000-000000000000",
    );

    expect(error).toMatchObject({ statusCode: 404, name: "not_found" });
  });
});

describe("batch", () => {
  it("sends a strict batch", async () => {
    const { data, error } = await resend.batch.send([
      {
        from: "a@mail.example.com",
        to: "one@example.net",
        subject: "1",
        text: "1",
      },
      {
        from: "a@mail.example.com",
        to: "two@example.net",
        subject: "2",
        text: "2",
      },
    ]);

    expect(error).toBeNull();
    expect(data?.data).toHaveLength(2);
  });

  it("fails a strict batch with one bad email", async () => {
    const { error } = await resend.batch.send([
      {
        from: "a@mail.example.com",
        to: "one@example.net",
        subject: "1",
        text: "1",
      },
      {
        from: "a@unknown.example.org",
        to: "two@example.net",
        subject: "2",
        text: "2",
      },
    ]);

    expect(error).toMatchObject({ statusCode: 403, name: "validation_error" });
    expect(error?.message).toContain("emails[1]");
  });

  it("returns errors per email in permissive mode", async () => {
    const { data, error } = await resend.batch.send(
      [
        {
          from: "a@mail.example.com",
          to: "one@example.net",
          subject: "1",
          text: "1",
        },
        {
          from: "a@unknown.example.org",
          to: "two@example.net",
          subject: "2",
          text: "2",
        },
      ],
      { batchValidation: "permissive" },
    );

    expect(error).toBeNull();
    expect(data?.data).toHaveLength(1);
    expect(data?.errors).toEqual([
      { index: 1, message: expect.stringContaining("not verified") },
    ]);
  });
});

describe("auth", () => {
  it("rejects a missing or unknown key", async () => {
    const bad = new Resend("fs_nope", { baseUrl: BASE });

    const { error } = await bad.emails.send({
      from: "a@mail.example.com",
      to: "x@example.net",
      subject: "x",
      text: "x",
    });

    expect(error).toMatchObject({ statusCode: 403, name: "invalid_api_key" });

    const res = await fetch(`${BASE}/emails`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ name: "missing_api_key" });
  });

  it("limits a sending key to the send routes and its domain", async () => {
    const other = await addDomain("other.example.com");

    const { token } = await newKey({
      permission: "sending_access",
      domain_id: other,
    });

    const sending = new Resend(token, { baseUrl: BASE });

    const list = await sending.emails.list();
    expect(list.error).toMatchObject({
      statusCode: 401,
      name: "restricted_api_key",
    });

    const wrong = await sending.emails.send({
      from: "a@mail.example.com",
      to: "x@example.net",
      subject: "x",
      text: "x",
    });

    expect(wrong.error).toMatchObject({
      statusCode: 403,
      name: "validation_error",
    });

    const ok = await sending.emails.send({
      from: "a@other.example.com",
      to: "x@example.net",
      subject: "x",
      text: "x",
    });

    expect(ok.error).toBeNull();
  });
});

describe("api keys", () => {
  it("creates, lists and removes a key", async () => {
    const created = await resend.apiKeys.create({
      name: "ci",
      permission: "sending_access",
      domain_id: domainId,
    });

    expect(created.data?.token).toMatch(/^fs_/);
    const list = await resend.apiKeys.list();
    expect(list.data?.data.some((k) => k.id === created.data!.id)).toBe(true);
    const removed = await resend.apiKeys.remove(created.data!.id);
    expect(removed.error).toBeNull();
    const after = await resend.apiKeys.list();
    expect(after.data?.data.some((k) => k.id === created.data!.id)).toBe(false);
  });
});

describe("domains", () => {
  it("lists, gets and updates a domain", async () => {
    const list = await resend.domains.list();
    expect(list.data?.data.some((d) => d.id === domainId)).toBe(true);
    const got = await resend.domains.get(domainId);
    expect(got.data).toMatchObject({
      object: "domain",
      name: "mail.example.com",
      status: "verified",
      records: [],
    });

    const updated = await resend.domains.update({
      id: domainId,
      openTracking: false,
    });

    expect(updated.data).toEqual({ object: "domain", id: domainId });
    expect((await resend.domains.get(domainId)).data?.open_tracking).toBe(
      false,
    );
  });

  it("refuses to create a domain without a Cloudflare token", async () => {
    const { error } = await resend.domains.create({ name: "new.example.com" });
    expect(error).toMatchObject({ statusCode: 403, name: "validation_error" });
  });
});

describe("webhooks", () => {
  it("manages a webhook and signs like Resend", async () => {
    const created = await resend.webhooks.create({
      endpoint: "https://hooks.example.com/in",
      events: ["email.delivered"],
    });

    expect(created.data?.signing_secret).toMatch(/^whsec_/);
    const id = created.data!.id;

    const got = await resend.webhooks.get(id);
    expect(got.data).toMatchObject({
      object: "webhook",
      endpoint: "https://hooks.example.com/in",
      status: "enabled",
    });

    const updated = await resend.webhooks.update(id, {
      status: "disabled",
      events: ["email.bounced", "email.delivered"],
    });

    expect(updated.error).toBeNull();
    expect((await resend.webhooks.get(id)).data?.status).toBe("disabled");

    const rotated = await resend.webhooks.rotateSigningSecret(id);
    expect(rotated.data?.signing_secret).not.toBe(created.data?.signing_secret);

    const { sign } = await import("../src/webhooks/sign");

    const body = JSON.stringify({
      type: "email.delivered",
      created_at: new Date().toISOString(),
      data: {},
    });

    const ts = Math.floor(Date.now() / 1000);

    const signature = await sign(
      rotated.data!.signing_secret,
      "msg_1",
      ts,
      body,
    );

    const verified = resend.webhooks.verify({
      payload: body,
      headers: { id: "msg_1", timestamp: String(ts), signature },
      webhookSecret: rotated.data!.signing_secret,
    });

    expect(verified).toMatchObject({ type: "email.delivered" });

    const removed = await resend.webhooks.remove(id);
    expect(removed.data).toEqual({ object: "webhook", id, deleted: true });
  });

  it("rejects an unknown event type", async () => {
    const { error } = await resend.webhooks.create({
      endpoint: "https://x.example.com",
      // Not a Resend event.
      // SAFETY: the SDK type allows only Resend events. The test sends a
      // different name to check the validation of the Worker.
      events: ["email.nope" as "email.opened"],
    });

    expect(error).toMatchObject({ statusCode: 422, name: "validation_error" });
  });
});
