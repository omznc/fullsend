import { env } from "cloudflare:workers";
import {
  Resend,
  type SuppressionAddedEvent,
  type SuppressionRemovedEvent,
  type WebhookEvent,
} from "resend";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ACCEPTED_WEBHOOK_EVENTS, WEBHOOK_EVENTS } from "../src/events/record";
import { createKey } from "../src/keys/service";
import { parseJsonText } from "../src/lib/json";
import { deliver } from "../src/webhooks/deliver";
import { testBody } from "../src/webhooks/payload";
import { addDomain, BASE, call, newKey, routeFetchToWorker } from "./helpers";

// Runs the official resend SDK against the Worker, with no patch: only
// the base URL and the key change.

const suppressionEvent = z.object({
  type: z.enum(["suppression.added", "suppression.removed"]),
  created_at: z.string(),
  data: z.object({
    id: z.string(),
    email: z.string(),
    origin: z.enum(["bounce", "complaint", "manual"]),
    source_id: z.string().nullable(),
    created_at: z.string(),
  }),
});

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

describe("api key update", () => {
  it("renames a key and refuses a bad name or a removed key", async () => {
    const made = await resend.apiKeys.create({ name: "before" });
    const id = made.data!.id;

    const updated = await resend.apiKeys.update(id, { name: "  after  " });
    expect(updated.data).toEqual({ object: "api_key", id });

    const list = await resend.apiKeys.list({ limit: 100 });
    expect(list.data?.data.find((k) => k.id === id)?.name).toBe("after");

    const empty = await resend.apiKeys.update(id, { name: "  " });
    expect(empty.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });

    // @ts-expect-error: the test leaves out the required field.
    const missing = await resend.apiKeys.update(id, {});
    expect(missing.error).toMatchObject({
      statusCode: 422,
      name: "missing_required_field",
    });

    const unknown = await resend.apiKeys.update(crypto.randomUUID(), {
      name: "x",
    });

    expect(unknown.error).toMatchObject({ statusCode: 404, name: "not_found" });
    await resend.apiKeys.remove(id);

    const removed = await resend.apiKeys.update(id, { name: "x" });
    expect(removed.error).toMatchObject({ statusCode: 404, name: "not_found" });
  });

  it("limits a sending key", async () => {
    const { token, id } = await newKey({ permission: "sending_access" });
    const sender = new Resend(token, { baseUrl: BASE });
    const res = await sender.apiKeys.update(id, { name: "x" });

    expect(res.error).toMatchObject({
      statusCode: 401,
      name: "restricted_api_key",
    });
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

describe("pagination", () => {
  // Reads each page with `after` and returns the ids in order.
  async function walk(
    list: (after?: string) => Promise<{
      data: { has_more: boolean; data: { id: string }[] } | null;
    }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    let after: string | undefined;

    for (let i = 0; i < 20; i++) {
      const page = await list(after);

      expect(page.data).not.toBeNull();
      ids.push(...page.data!.data.map((r) => r.id));

      if (!page.data!.has_more) return ids;
      after = page.data!.data.at(-1)!.id;
    }

    throw new Error("The list did not end.");
  }

  it("pages domains", async () => {
    await addDomain("p1.example.com");
    await addDomain("p2.example.com");
    await addDomain("p3.example.com");

    const first = await resend.domains.list({ limit: 2 });
    expect(first.data?.data).toHaveLength(2);
    expect(first.data?.has_more).toBe(true);

    const ids = await walk((after) =>
      resend.domains.list(after ? { limit: 2, after } : { limit: 2 }),
    );

    const all = await resend.domains.list({ limit: 100 });
    expect(all.data?.has_more).toBe(false);
    expect(ids).toEqual(all.data!.data.map((d) => d.id));
    expect(new Set(ids).size).toBe(ids.length);

    const before = await resend.domains.list({ limit: 1, before: ids[2]! });
    expect(before.data?.data.map((d) => d.id)).toEqual([ids[1]]);
  });

  it("pages API keys and skips a removed key", async () => {
    const made = [];

    for (let i = 0; i < 3; i++) {
      made.push((await resend.apiKeys.create({ name: `page-${i}` })).data!.id);
    }

    await resend.apiKeys.remove(made[1]!);

    const ids = await walk((after) =>
      resend.apiKeys.list(after ? { limit: 2, after } : { limit: 2 }),
    );

    expect(ids).toContain(made[0]);
    expect(ids).toContain(made[2]);
    expect(ids).not.toContain(made[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("pages webhooks", async () => {
    for (let i = 0; i < 3; i++) {
      await resend.webhooks.create({
        endpoint: `https://hooks.example.com/page-${i}`,
        // No test sends this event, so no delivery runs.
        events: ["contact.created"],
      });
    }

    const first = await resend.webhooks.list({ limit: 2 });
    expect(first.data?.has_more).toBe(true);
    expect(first.data?.data[0]).toHaveProperty("endpoint");

    const ids = await walk((after) =>
      resend.webhooks.list(after ? { limit: 2, after } : { limit: 2 }),
    );

    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects a bad limit and an unknown cursor", async () => {
    const limit = await resend.domains.list({ limit: 101 });
    expect(limit.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });

    const cursor = await resend.webhooks.list({ after: "missing" });
    expect(cursor.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });
  });
});

describe("webhook event types", () => {
  // Each type of the SDK. The type `Record<WebhookEvent, true>` fails to
  // compile when the SDK adds a type that this list lacks.
  const SDK_EVENTS: Record<WebhookEvent, true> = {
    "email.sent": true,
    "email.scheduled": true,
    "email.delivered": true,
    "email.delivery_delayed": true,
    "email.complained": true,
    "email.bounced": true,
    "email.opened": true,
    "email.clicked": true,
    "email.received": true,
    "email.failed": true,
    "email.suppressed": true,
    "contact.created": true,
    "contact.updated": true,
    "contact.deleted": true,
    "contact.topics.updated": true,
    "domain.created": true,
    "domain.updated": true,
    "domain.deleted": true,
    "suppression.added": true,
    "suppression.removed": true,
    "topic.created": true,
    "topic.updated": true,
    "topic.deleted": true,
  };

  const all = Object.keys(SDK_EVENTS);

  it("accepts each type of the SDK, and sends a part of them", () => {
    expect([...ACCEPTED_WEBHOOK_EVENTS].toSorted()).toEqual(all.toSorted());

    for (const type of WEBHOOK_EVENTS) {
      expect(ACCEPTED_WEBHOOK_EVENTS).toContain(type);
    }
  });

  it("creates and updates a webhook for each type", async () => {
    const created = await resend.webhooks.create({
      endpoint: "https://hooks.example.com/all",
      // SAFETY: the keys of SDK_EVENTS are the WebhookEvent types.
      events: all as WebhookEvent[],
    });

    expect(created.error).toBeNull();
    const id = created.data!.id;
    const got = await resend.webhooks.get(id);
    expect(got.data?.events).toHaveLength(all.length);

    const updated = await resend.webhooks.update(id, {
      events: ["contact.created", "domain.updated"],
    });

    expect(updated.error).toBeNull();
    expect((await resend.webhooks.get(id)).data?.events).toEqual([
      "contact.created",
      "domain.updated",
    ]);

    // Later tests send emails. Remove the webhook, so none goes out.
    await resend.webhooks.remove(id);
  });
});

describe("suppressions", () => {
  it("adds, reads, lists and removes a suppression", async () => {
    const email = "Sup+Tag@Example.com";
    const added = await resend.suppressions.add({ email });

    expect(added.error).toBeNull();
    expect(added.data).toMatchObject({ object: "suppression" });
    const id = added.data!.id;

    // Adding again keeps the same id.
    expect((await resend.suppressions.add({ email })).data?.id).toBe(id);

    const byId = await resend.suppressions.get(id);

    expect(byId.data).toMatchObject({
      object: "suppression",
      id,
      email: "sup+tag@example.com",
      origin: "manual",
      source_id: null,
    });

    // The SDK encodes the `+` of the address.
    const byEmail = await resend.suppressions.get("sup+tag@example.com");
    expect(byEmail.data?.id).toBe(id);

    const manual = await resend.suppressions.list({ origin: "manual" });
    expect(manual.data?.object).toBe("list");
    expect(manual.data?.data.some((s) => s.id === id)).toBe(true);
    expect(manual.data?.data[0]).not.toHaveProperty("object");

    const bounce = await resend.suppressions.list({ origin: "bounce" });
    expect(bounce.data?.data.some((s) => s.id === id)).toBe(false);

    const removed = await resend.suppressions.remove("sup+tag@example.com");
    expect(removed.data).toEqual({ object: "suppression", id, deleted: true });

    const gone = await resend.suppressions.get(id);
    expect(gone.error).toMatchObject({ statusCode: 404, name: "not_found" });
    const again = await resend.suppressions.remove(id);
    expect(again.error).toMatchObject({ statusCode: 404, name: "not_found" });
  });

  it("maps a bounce and a complaint to their origin", async () => {
    await env.DB.prepare(
      `INSERT INTO suppressions (address, reason, source, email_id, created_at)
       VALUES ('hard@example.net', 'hard_bounce', 'cloudflare_event', 'email-1', 5),
              ('spam@example.net', 'complaint', 'cloudflare_event', NULL, 6)`,
    ).run();

    const hard = await resend.suppressions.get("hard@example.net");
    expect(hard.data).toMatchObject({ origin: "bounce", source_id: "email-1" });

    const spam = await resend.suppressions.get("spam@example.net");
    expect(spam.data).toMatchObject({ origin: "complaint", source_id: null });

    const list = await resend.suppressions.list({ origin: "complaint" });
    expect(list.data?.data.map((s) => s.email)).toContain("spam@example.net");
  });

  it("pages the list", async () => {
    const emails = ["pg1", "pg2", "pg3"].map((n) => `${n}@example.org`);
    const batch = await resend.suppressions.batch.add({ emails });
    expect(batch.error).toBeNull();

    const first = await resend.suppressions.list({ limit: 2 });
    expect(first.data?.data).toHaveLength(2);
    expect(first.data?.has_more).toBe(true);

    const seen: string[] = [];
    let after: string | undefined;

    for (let i = 0; i < 20; i++) {
      const page = await resend.suppressions.list(
        after ? { limit: 2, after } : { limit: 2 },
      );

      seen.push(...page.data!.data.map((s) => s.email));

      if (!page.data!.has_more) break;
      after = page.data!.data.at(-1)!.id;
    }

    for (const e of emails) expect(seen).toContain(e);
    expect(new Set(seen).size).toBe(seen.length);

    const bad = await resend.suppressions.list({ after: "nope" });
    expect(bad.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });

    const origin = await resend.suppressions.list({
      // SAFETY: the test sends a value that the SDK type does not allow.
      origin: "other" as "manual",
    });

    expect(origin.error).toMatchObject({
      statusCode: 422,
      name: "invalid_parameter",
    });
  });

  it("adds and removes a batch", async () => {
    const emails = ["b1@example.org", "b2@example.org", "b2@example.org"];
    const added = await resend.suppressions.batch.add({ emails });

    expect(added.data?.data).toHaveLength(2);
    expect(added.data?.data[0]).toMatchObject({ object: "suppression" });
    const ids = added.data!.data.map((s) => s.id);

    const byEmail = await resend.suppressions.batch.remove({
      emails: ["b1@example.org", "missing@example.org"],
    });

    expect(byEmail.data?.data).toEqual([
      { object: "suppression", id: ids[0], deleted: true },
      {
        object: "suppression",
        id: expect.any(String),
        deleted: false,
      },
    ]);

    const byId = await resend.suppressions.batch.remove({
      ids: [ids[1]!, "not-an-id"],
    });

    expect(byId.data?.data).toEqual([
      { object: "suppression", id: ids[1], deleted: true },
      { object: "suppression", id: "not-an-id", deleted: false },
    ]);

    expect((await resend.suppressions.get(ids[1]!)).error?.statusCode).toBe(
      404,
    );
  });

  it("rejects bad input", async () => {
    // @ts-expect-error: the test leaves out the required field.
    const missing = await resend.suppressions.add({});
    expect(missing.error).toMatchObject({
      statusCode: 422,
      name: "missing_required_field",
    });

    const bad = await resend.suppressions.add({ email: "not an email" });
    expect(bad.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });

    const empty = await resend.suppressions.batch.add({ emails: [] });
    expect(empty.error).toMatchObject({ statusCode: 422 });

    const many = await resend.suppressions.batch.add({
      emails: Array.from({ length: 101 }, (_, i) => `m${i}@example.org`),
    });

    expect(many.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });
  });

  it("limits a sending key", async () => {
    const { token } = await newKey({ permission: "sending_access" });
    const sender = new Resend(token, { baseUrl: BASE });
    const list = await sender.suppressions.list();

    expect(list.error).toMatchObject({
      statusCode: 401,
      name: "restricted_api_key",
    });
  });

  it("sends suppression events to a webhook", async () => {
    // A new key has its own rate limit bucket.
    const { token } = await newKey();
    const client = new Resend(token, { baseUrl: BASE });

    const hook = await client.webhooks.create({
      endpoint: "https://hooks.example.com/sup",
      events: ["suppression.added", "suppression.removed"],
    });

    const queue = vi.spyOn(env.HOOKS_QUEUE, "sendBatch").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });

    // The events that the Worker put on the queue. The schema is assigned
    // to the SDK types, so a change of an SDK type breaks the compile.
    const types = () =>
      queue.mock.calls.flatMap(([batch]) =>
        [...batch].flatMap((m) => {
          const body = m.body.body;

          if (!body) return [];

          const event: SuppressionAddedEvent | SuppressionRemovedEvent =
            suppressionEvent.parse(parseJsonText(body));

          return [event];
        }),
      );

    try {
      const { data } = await client.suppressions.add({
        email: "evt@example.org",
      });

      await client.suppressions.add({ email: "evt@example.org" });
      expect(types().map((e) => e.type)).toEqual(["suppression.added"]);

      expect(types()[0]!.data).toMatchObject({
        id: data!.id,
        email: "evt@example.org",
        origin: "manual",
        source_id: null,
      });

      await client.suppressions.remove(data!.id);
      await client.suppressions.remove(data!.id);
      expect(types().map((e) => e.type)).toEqual([
        "suppression.added",
        "suppression.removed",
      ]);

      await client.suppressions.batch.add({
        emails: ["evt@example.org", "evt2@example.org"],
      });

      // The batch adds two addresses. The first one is new again.
      expect(types()).toHaveLength(4);
    } finally {
      queue.mockRestore();
      // Later tests must not send to this endpoint.
      await client.webhooks.remove(hook.data!.id);
    }
  });
});

describe("email attachments", () => {
  let client: Resend;
  let emailId: string;

  beforeAll(async () => {
    // A new key has its own rate limit bucket.
    const { token } = await newKey();
    client = new Resend(token, { baseUrl: BASE });

    const { data } = await client.emails.send({
      from: "a@mail.example.com",
      to: "omar@example.net",
      subject: "files",
      text: "see files",
      attachments: [
        {
          filename: "a.txt",
          content: btoa("hello"),
          contentType: "text/plain",
        },
        { filename: "logo.png", content: btoa("PNG"), contentId: "logo" },
        { filename: "c.txt", content: btoa("third") },
      ],
    });

    emailId = data!.id;
  });

  it("lists the attachments with signed download links", async () => {
    const list = await client.emails.attachments.list({ emailId });

    expect(list.error).toBeNull();
    expect(list.data?.object).toBe("list");
    expect(list.data?.has_more).toBe(false);

    expect(list.data?.data[0]).toMatchObject({
      id: "0",
      filename: "a.txt",
      size: 5,
      content_type: "text/plain",
      content_disposition: "attachment",
    });

    expect(list.data?.data[0]).not.toHaveProperty("content_id");
    expect(list.data?.data[1]).toMatchObject({
      content_disposition: "inline",
      content_id: "logo",
    });

    const first = list.data!.data[0]!;
    expect(first.download_url).toContain(`/emails/${emailId}/attachments/0/`);
    expect(Date.parse(first.expires_at)).toBeGreaterThan(Date.now());
  });

  it("pages the attachments", async () => {
    const first = await client.emails.attachments.list({ emailId, limit: 2 });
    expect(first.data?.data.map((a) => a.id)).toEqual(["0", "1"]);
    expect(first.data?.has_more).toBe(true);

    const next = await client.emails.attachments.list({
      emailId,
      limit: 2,
      after: "1",
    });

    expect(next.data?.data.map((a) => a.id)).toEqual(["2"]);
    expect(next.data?.has_more).toBe(false);

    const before = await client.emails.attachments.list({
      emailId,
      limit: 1,
      before: "2",
    });

    expect(before.data?.data.map((a) => a.id)).toEqual(["1"]);
    expect(before.data?.has_more).toBe(true);

    const bad = await client.emails.attachments.list({ emailId, after: "9" });
    expect(bad.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });
  });

  it("gets one attachment and downloads it with no key", async () => {
    const got = await client.emails.attachments.get({ emailId, id: "2" });

    expect(got.data).toMatchObject({
      object: "attachment",
      id: "2",
      filename: "c.txt",
      size: 5,
    });

    const res = await fetch(got.data!.download_url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("third");
    expect(res.headers.get("Content-Disposition")).toContain(
      'filename="c.txt"',
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("refuses a link with a wrong signature or an old expiry", async () => {
    const got = await client.emails.attachments.get({ emailId, id: "0" });
    const url = new URL(got.data!.download_url);

    const tampered = new URL(url);
    tampered.searchParams.set("sig", "x".repeat(32));
    expect((await fetch(tampered)).status).toBe(403);

    const old = new URL(url);
    old.searchParams.set("expires", String(Date.now() - 1000));
    expect((await fetch(old)).status).toBe(403);

    // The link of one attachment does not open another one.
    const other = new URL(url);
    other.pathname = other.pathname.replace("/0/download", "/1/download");
    const res = await fetch(other);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ name: "invalid_access" });

    const bare = new URL(url);
    bare.search = "";
    expect((await fetch(bare)).status).toBe(403);
  });

  it("returns 404 for an unknown email or attachment", async () => {
    const email = await client.emails.attachments.list({
      emailId: "00000000-0000-0000-0000-000000000000",
    });

    expect(email.error).toMatchObject({ statusCode: 404, name: "not_found" });

    const one = await client.emails.attachments.get({ emailId, id: "7" });
    expect(one.error).toMatchObject({ statusCode: 404, name: "not_found" });
    const odd = await client.emails.attachments.get({ emailId, id: "x" });
    expect(odd.error).toMatchObject({ statusCode: 404, name: "not_found" });
  });

  it("returns 404 on download when retention deleted the body", async () => {
    const got = await client.emails.attachments.get({ emailId, id: "0" });

    const row = await env.DB.prepare("SELECT body_key FROM emails WHERE id = ?")
      .bind(emailId)
      .first<{ body_key: string }>();

    await env.BODIES.delete(row!.body_key);

    // The list reads D1, so it still works.
    expect(
      (await client.emails.attachments.list({ emailId })).data?.data,
    ).toHaveLength(3);

    const res = await fetch(got.data!.download_url);
    expect(res.status).toBe(404);
  });

  it("limits a sending key", async () => {
    const { token } = await newKey({ permission: "sending_access" });
    const sender = new Resend(token, { baseUrl: BASE });
    const res = await sender.emails.attachments.list({ emailId });

    expect(res.error).toMatchObject({
      statusCode: 401,
      name: "restricted_api_key",
    });
  });
});

describe("webhook events", () => {
  let client: Resend;
  let webhookId: string;
  let respond: (url: string) => Response | Promise<Response>;
  let prior: typeof fetch;

  // Stores one attempt of a message, with the stub response.
  // The pause gives each attempt its own millisecond, so the order is
  // clear.
  const attempt = async (messageId: string, n: number, type = "email.sent") => {
    await new Promise((resolve) => setTimeout(resolve, 5));

    return deliver(
      env,
      { webhookId, messageId, eventId: null, body: testBody(type) },
      n,
    );
  };

  beforeAll(async () => {
    const { token } = await newKey();
    client = new Resend(token, { baseUrl: BASE });

    const created = await client.webhooks.create({
      endpoint: "https://hooks.example.com/events",
      // No test sends this event, so only the stored attempts count.
      events: ["contact.created"],
    });

    webhookId = created.data!.id;

    // The Worker sends the webhook with fetch. The stub answers for the
    // endpoint and passes the other calls on.
    prior = globalThis.fetch;
    // SAFETY: the stub implements the (input, init) form of fetch. That is
    // the only form that the Worker and the resend SDK call.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const req = new Request(input, init);

      if (req.url.startsWith("https://hooks.example.com/")) {
        return respond(req.url);
      }

      return prior(req);
    }) as typeof fetch;

    // A message that failed, then worked.
    respond = () => new Response("try later", { status: 500 });
    await attempt("msg_retry", 1);
    respond = () => new Response("ok", { status: 200 });
    await attempt("msg_retry", 2);

    // A message that failed at once, with a body that tells the reason.
    respond = () => new Response("down", { status: 503 });
    await attempt("msg_waiting", 1, "domain.updated");

    // A message that used its last attempt.
    await attempt("msg_dead", 8);

    // A message that got no response.
    respond = () => {
      throw new Error("connection refused");
    };

    await attempt("msg_network", 1);
  });

  afterAll(() => {
    globalThis.fetch = prior;
  });

  it("lists the events with the status of each one", async () => {
    const list = await client.webhooks.events.list({ webhookId });

    expect(list.error).toBeNull();
    expect(list.data?.object).toBe("list");
    expect(list.data?.has_more).toBe(false);
    const byId = new Map(list.data!.data.map((e) => [e.id, e]));

    expect(byId.get("msg_retry")).toMatchObject({
      type: "email.sent",
      status: "success",
    });
    expect(byId.get("msg_waiting")).toMatchObject({
      type: "domain.updated",
      status: "attempting",
    });

    expect(byId.get("msg_dead")?.status).toBe("failed");
    expect(byId.get("msg_network")?.status).toBe("attempting");
    expect(byId.get("msg_retry")?.created_at).toMatch(/^\d{4}-/);
  });

  it("pages the events", async () => {
    const all = await client.webhooks.events.list({ webhookId, limit: 100 });
    const ids = all.data!.data.map((e) => e.id);
    expect(ids).toHaveLength(4);

    const seen: string[] = [];
    let after: string | undefined;

    for (let i = 0; i < 10; i++) {
      const page = await client.webhooks.events.list({
        webhookId,
        limit: 3,
        after,
      });

      seen.push(...page.data!.data.map((e) => e.id));

      if (!page.data!.has_more) break;
      after = page.data!.data.at(-1)!.id;
    }

    expect(seen).toEqual(ids);

    const bad = await client.webhooks.events.list({ webhookId, after: "nope" });
    expect(bad.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });
  });

  it("gets an event with its payload and next attempt", async () => {
    const waiting = await client.webhooks.events.get({
      webhookId,
      eventId: "msg_waiting",
    });

    expect(waiting.data).toMatchObject({
      object: "webhook_event",
      id: "msg_waiting",
      type: "domain.updated",
      status: "attempting",
      payload: { type: "domain.updated" },
    });

    // The first delay is 5 seconds after the attempt.
    expect(Date.parse(waiting.data!.next_attempt_at!)).toBeGreaterThan(
      Date.now() - 5000,
    );

    const done = await client.webhooks.events.get({
      webhookId,
      eventId: "msg_retry",
    });

    expect(done.data?.next_attempt_at).toBeNull();

    const unknown = await client.webhooks.events.get({
      webhookId,
      eventId: "msg_none",
    });

    expect(unknown.error).toMatchObject({ statusCode: 404, name: "not_found" });

    const hook = await client.webhooks.events.get({
      webhookId: crypto.randomUUID(),
      eventId: "msg_retry",
    });

    expect(hook.error).toMatchObject({ statusCode: 404, name: "not_found" });
  });

  it("lists the attempts of an event, newest first", async () => {
    const attempts = await client.webhooks.events.attempts.list({
      webhookId,
      eventId: "msg_retry",
    });

    expect(attempts.error).toBeNull();
    expect(attempts.data?.data.map((a) => a.http_status_code)).toEqual([
      200, 500,
    ]);
    expect(attempts.data?.data.map((a) => a.response)).toEqual([
      "ok",
      "try later",
    ]);
    expect(attempts.data?.data[0]?.sent_at).toMatch(/^\d{4}-/);

    const page = await client.webhooks.events.attempts.list({
      webhookId,
      eventId: "msg_retry",
      limit: 1,
    });

    expect(page.data?.has_more).toBe(true);

    const network = await client.webhooks.events.attempts.list({
      webhookId,
      eventId: "msg_network",
    });

    expect(network.data?.data[0]).toMatchObject({
      http_status_code: 0,
      response: "connection refused",
    });

    const unknown = await client.webhooks.events.attempts.list({
      webhookId,
      eventId: "msg_none",
    });

    expect(unknown.error).toMatchObject({ statusCode: 404 });
  });

  it("replays an event with the same id and body", async () => {
    const send = vi.spyOn(env.HOOKS_QUEUE, "send").mockResolvedValue({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    });

    try {
      const replay = await client.webhooks.events.replay({
        webhookId,
        eventId: "msg_retry",
      });

      expect(replay.data).toEqual({ object: "webhook_event", id: "msg_retry" });
      expect(send).toHaveBeenCalledTimes(1);

      const message = send.mock.calls[0]![0];
      expect(message).toMatchObject({
        webhookId,
        messageId: "msg_retry",
        eventId: null,
      });
      expect(parseJsonText(message.body!)).toMatchObject({
        type: "email.sent",
      });

      const unknown = await client.webhooks.events.replay({
        webhookId,
        eventId: "msg_none",
      });

      expect(unknown.error).toMatchObject({
        statusCode: 404,
        name: "not_found",
      });

      await client.webhooks.update(webhookId, { status: "disabled" });

      const off = await client.webhooks.events.replay({
        webhookId,
        eventId: "msg_retry",
      });

      expect(off.error).toMatchObject({
        statusCode: 422,
        name: "validation_error",
      });
      await client.webhooks.update(webhookId, { status: "enabled" });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
    }
  });

  it("limits a sending key", async () => {
    const { token } = await newKey({ permission: "sending_access" });
    const sender = new Resend(token, { baseUrl: BASE });
    const res = await sender.webhooks.events.list({ webhookId });

    expect(res.error).toMatchObject({
      statusCode: 401,
      name: "restricted_api_key",
    });
  });
});

describe("email metrics", () => {
  let client: Resend;
  let domainA: string;
  let domainB: string;

  const at = (iso: string) => Date.parse(iso);

  async function email(id: string, domainId: string) {
    await env.DB.prepare(
      `INSERT INTO emails (id, api_key_id, domain_id, "from", "to", subject, status, last_event, last_event_at, created_at)
       VALUES (?, 'test', ?, 'a@x.example', '["b@y.example"]', 's', 'sent', 'sent', 0, 0)`,
    )
      .bind(id, domainId)
      .run();
  }

  async function event(
    emailId: string,
    type: string,
    time: string,
    extra: { data?: string; bot?: string } = {},
  ) {
    await env.DB.prepare(
      `INSERT INTO email_events (id, email_id, type, data, bot, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        emailId,
        type,
        extra.data ?? null,
        extra.bot ?? null,
        at(time),
      )
      .run();
  }

  beforeAll(async () => {
    const { token } = await newKey();
    client = new Resend(token, { baseUrl: BASE });
    domainA = await addDomain("metrics-a.example.com");
    domainB = await addDomain("metrics-b.example.com");
    await email("m-e1", domainA);
    await email("m-e2", domainA);
    await email("m-e3", domainB);

    await event("m-e1", "sent", "2025-03-03T10:00:00Z");
    await event("m-e1", "delivered", "2025-03-03T10:01:00Z");
    await event("m-e1", "opened", "2025-03-03T10:05:00Z");
    await event("m-e1", "opened", "2025-03-03T10:06:00Z");
    await event("m-e1", "clicked", "2025-03-03T10:07:00Z");
    await event("m-e2", "sent", "2025-03-03T11:00:00Z");

    await event("m-e2", "bounced", "2025-03-03T11:01:00Z", {
      data: JSON.stringify({ bounce: { type: "hard" } }),
    });

    // A bot open does not count.
    await event("m-e2", "opened", "2025-03-03T11:02:00Z", { bot: "scanner" });
    await event("m-e3", "sent", "2025-03-04T09:00:00Z");
    await event("m-e3", "delivered", "2025-03-04T09:01:00Z");
    await event("m-e3", "complained", "2025-03-04T09:02:00Z");
    // After the range.
    await event("m-e3", "sent", "2025-03-05T00:00:00Z");
  });

  const range = { startDate: "2025-03-03", endDate: "2025-03-04" } as const;

  it("gives the totals of a range, with the last day counted", async () => {
    const res = await client.emails.metrics(range);

    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({
      object: "metrics",
      start_date: "2025-03-03T00:00:00.000Z",
      end_date: "2025-03-04T23:59:59.999Z",
      dimensions: [],
      granularity: "daily",
      totals: {
        sent: 3,
        delivered: 2,
        bounced: 1,
        bounced_permanent: 1,
        bounced_transient: 0,
        bounced_undetermined: 0,
        opened: 2,
        unique_opened: 1,
        clicked: 1,
        unique_clicked: 1,
        complained: 1,
        delivery_rate: 66.7,
        bounce_rate: 33.3,
        open_rate: 50,
        complaint_rate: 50,
      },
    });

    expect(res.data).not.toHaveProperty("data");
    expect(res.data?.totals).not.toHaveProperty("received");
    expect(res.data?.totals).not.toHaveProperty("unsubscribed");
  });

  it("breaks the answer down by period", async () => {
    const res = await client.emails.metrics({
      ...range,
      dimensions: ["period"],
      metrics: ["sent", "delivered"],
    });

    expect(res.data?.metrics).toEqual(["sent", "delivered"]);

    expect(res.data?.data).toEqual([
      { period: "2025-03-03", sent: 2, delivered: 1 },
      { period: "2025-03-04", sent: 1, delivered: 1 },
    ]);

    const weekly = await client.emails.metrics({
      ...range,
      dimensions: ["period"],
      granularity: "weekly",
      metrics: ["sent"],
    });

    // 2025-03-03 is a Monday.
    expect(weekly.data?.data).toEqual([{ period: "2025-03-03", sent: 3 }]);

    const hourly = await client.emails.metrics({
      ...range,
      dimensions: ["period"],
      granularity: "hourly",
      metrics: ["sent"],
    });

    expect(hourly.data?.data?.map((r) => r.period)).toEqual([
      "2025-03-03T10:00:00.000Z",
      "2025-03-03T11:00:00.000Z",
      "2025-03-04T09:00:00.000Z",
    ]);
  });

  it("breaks the answer down by domain and filters it", async () => {
    const res = await client.emails.metrics({
      ...range,
      dimensions: ["domain"],
      metrics: ["sent"],
    });

    expect(res.data?.data).toEqual([
      {
        domain_id: domainA,
        domain_name: "metrics-a.example.com",
        sent: 2,
      },
      {
        domain_id: domainB,
        domain_name: "metrics-b.example.com",
        sent: 1,
      },
    ]);

    const only = await client.emails.metrics({
      ...range,
      domainId: [domainB],
      metrics: ["sent", "complained"],
    });

    expect(only.data?.totals).toEqual({ sent: 1, complained: 1 });

    const byEmail = await client.emails.metrics({
      ...range,
      emailId: ["m-e1"],
      dimensions: ["email"],
      metrics: ["opened", "unique_opened"],
    });

    expect(byEmail.data?.data).toEqual([
      { email_id: "m-e1", opened: 2, unique_opened: 1 },
    ]);
  });

  it("uses today and the 6 days before it by default", async () => {
    const res = await client.emails.metrics({
      // The events of the other tests are in the past. This domain has
      // none in the last 7 days.
      domainId: [domainA],
      metrics: ["sent"],
    });

    const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;

    expect(res.data?.start_date).toBe(
      new Date(today - 6 * 86_400_000).toISOString(),
    );
    expect(Date.now() - Date.parse(res.data!.end_date)).toBeLessThan(60_000);
    expect(res.data?.totals).toEqual({ sent: 0 });
  });

  it("counts an email one time when it has many recipients", async () => {
    await email("m-multi", domainB);
    await event("m-multi", "sent", "2025-04-01T10:00:00Z");
    await event("m-multi", "delivered", "2025-04-01T10:01:00Z");
    await event("m-multi", "delivered", "2025-04-01T10:01:05Z");

    const res = await client.emails.metrics({
      startDate: "2025-04-01",
      endDate: "2025-04-01",
      emailId: ["m-multi"],
      metrics: ["sent", "delivered", "delivery_rate"],
    });

    expect(res.data?.end_date).toBe("2025-04-01T23:59:59.999Z");
    expect(res.data?.totals).toEqual({
      sent: 1,
      delivered: 1,
      delivery_rate: 100,
    });
  });

  it("takes a repeated parameter and a comma list", async () => {
    const { token } = await newKey();

    const get = async (query: string) =>
      (
        await call(`/emails/metrics?${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json<{ metrics: string[]; totals: Record<string, number> }>();

    const repeated = await get(
      "start_date=2025-03-03&end_date=2025-03-04&metrics=sent&metrics=delivered",
    );

    expect(repeated.metrics).toEqual(["sent", "delivered"]);

    const domains = await get(
      `start_date=2025-03-03&end_date=2025-03-04&metrics=sent&domain_id=${domainA}&domain_id=${domainB}`,
    );

    expect(domains.totals).toEqual({ sent: 3 });

    const mixed = await get(
      `start_date=2025-03-03&end_date=2025-03-04&metrics=sent&domain_id=${domainA},${domainB}`,
    );

    expect(mixed.totals).toEqual({ sent: 3 });
  });

  it("refuses what fullsend cannot give", async () => {
    const zone = await client.emails.metrics({
      ...range,
      timezone: "Europe/Berlin",
    });

    expect(zone.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });
    expect(
      (await client.emails.metrics({ ...range, timezone: "UTC" })).error,
    ).toBeNull();

    const broadcast = await client.emails.metrics({
      ...range,
      dimensions: ["broadcast"],
    });

    expect(broadcast.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });

    const filter = await client.emails.metrics({
      ...range,
      broadcastId: ["b1"],
    });

    expect(filter.error).toMatchObject({
      statusCode: 422,
      name: "validation_error",
    });

    const metric = await client.emails.metrics({
      ...range,
      // SAFETY: the test sends a value that the SDK type does not allow.
      metrics: ["nope" as "sent"],
    });

    expect(metric.error).toMatchObject({
      statusCode: 422,
      name: "invalid_parameter",
    });

    const order = await client.emails.metrics({
      startDate: "2025-03-04",
      endDate: "2025-03-01",
    });

    expect(order.error).toMatchObject({
      statusCode: 422,
      name: "invalid_parameter",
    });

    const date = await client.emails.metrics({ startDate: "soon" });
    expect(date.error).toMatchObject({
      statusCode: 422,
      name: "invalid_parameter",
    });

    // A metric of the SDK that fullsend does not have gives no value.
    const missing = await client.emails.metrics({
      ...range,
      metrics: ["received", "sent"],
    });

    expect(missing.data?.totals).toEqual({ sent: 3 });
  });

  it("does not take /emails/metrics for an email id", async () => {
    const { token } = await newKey({ permission: "sending_access" });
    const sender = new Resend(token, { baseUrl: BASE });
    const res = await sender.emails.metrics();

    expect(res.error).toMatchObject({
      statusCode: 401,
      name: "restricted_api_key",
    });
  });
});

describe("logs", () => {
  it("lists and reads the request log", async () => {
    // A key with a high rate limit, for the polling below.
    const { token } = await createKey(env, { name: "logs", rate_limit: 1000 });
    const resend = new Resend(token, { baseUrl: BASE });

    await resend.emails.get("00000000-0000-4000-8000-000000000000");

    // The Worker writes the log row after the response.
    let list = await resend.logs.list({ limit: 100 });

    for (let i = 0; i < 50; i++) {
      if (list.data?.data.some((l) => l.endpoint.startsWith("/emails/0")))
        break;

      await new Promise((resolve) => setTimeout(resolve, 20));
      list = await resend.logs.list({ limit: 100 });
    }

    expect(list.error).toBeNull();
    expect(list.data?.object).toBe("list");

    const entry = list.data?.data.find((l) =>
      l.endpoint.startsWith("/emails/0"),
    );

    expect(entry).toMatchObject({
      method: "GET",
      endpoint: "/emails/00000000-0000-4000-8000-000000000000",
      response_status: 404,
      user_agent: null,
    });
    expect(new Date(entry!.created_at).toISOString()).toBe(entry!.created_at);

    const one = await resend.logs.get(entry!.id);

    expect(one.data).toMatchObject({
      object: "log",
      id: entry!.id,
      response_status: 404,
      request_body: null,
      response_body: { statusCode: 404, name: "not_found" },
    });

    const paged = await resend.logs.list({ limit: 1 });
    expect(paged.data?.data).toHaveLength(1);
    expect(paged.data?.has_more).toBe(true);

    const next = await resend.logs.list({
      limit: 1,
      after: paged.data!.data[0]!.id,
    });

    expect(next.data?.data[0]?.id).not.toBe(paged.data!.data[0]!.id);

    const missing = await resend.logs.get("no-such-log");
    expect(missing.error).toMatchObject({ statusCode: 404, name: "not_found" });
  });

  it("refuses a sending key", async () => {
    const { token } = await newKey({ permission: "sending_access" });
    const sender = new Resend(token, { baseUrl: BASE });
    const res = await sender.logs.list();

    expect(res.error).toMatchObject({
      statusCode: 401,
      name: "restricted_api_key",
    });
  });
});
