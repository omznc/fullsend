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
import { parseJsonText } from "../src/lib/json";
import { addDomain, BASE, newKey, routeFetchToWorker } from "./helpers";

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
        events: ["email.sent"],
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
      name: "invalid_parameter",
    });

    const cursor = await resend.webhooks.list({ after: "missing" });
    expect(cursor.error).toMatchObject({
      statusCode: 422,
      name: "invalid_parameter",
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
      name: "invalid_parameter",
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
    await resend.webhooks.create({
      endpoint: "https://hooks.example.com/sup",
      events: ["suppression.added", "suppression.removed"],
    });

    const queue = vi
      .spyOn(env.HOOKS_QUEUE, "sendBatch")
      .mockResolvedValue({
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
      const { data } = await resend.suppressions.add({
        email: "evt@example.org",
      });
      await resend.suppressions.add({ email: "evt@example.org" });
      expect(types().map((e) => e.type)).toEqual(["suppression.added"]);

      expect(types()[0]!.data).toMatchObject({
        id: data!.id,
        email: "evt@example.org",
        origin: "manual",
        source_id: null,
      });

      await resend.suppressions.remove(data!.id);
      await resend.suppressions.remove(data!.id);
      expect(types().map((e) => e.type)).toEqual([
        "suppression.added",
        "suppression.removed",
      ]);

      await resend.suppressions.batch.add({
        emails: ["evt@example.org", "evt2@example.org"],
      });

      // The batch adds two addresses. The first one is new again.
      expect(types()).toHaveLength(4);
    } finally {
      queue.mockRestore();
    }
  });
});
