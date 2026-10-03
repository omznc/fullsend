import type { EmailStatus } from "../db/schema";
import type { Env } from "../env";
import { type EventData, WEBHOOK_EVENT } from "../events/record";
import { isJsonObject, type JsonObject, parseJsonText } from "../lib/json";
import { iso } from "../lib/time";
import { type EmailDbRow, rowToEmail } from "../send/consumer";

interface EventRow {
  id: string;
  email_id: string;
  recipient: string | null;
  type: EmailStatus;
  data: string | null;
  created_at: number;
}

// Reads the `data` column of an event. recordEvent stores a JSON object.
function eventData(text: string): EventData {
  const value = parseJsonText(text);

  return isJsonObject(value) ? value : {};
}

// Builds the Resend webhook body for an email event. Returns null when
// the event or the email no longer exists.
export async function buildEventBody(
  env: Env,
  eventId: string,
): Promise<{ type: string; body: string } | null> {
  const ev = await env.DB.prepare("SELECT * FROM email_events WHERE id = ?")
    .bind(eventId)
    .first<EventRow>();

  if (!ev) return null;

  const row = await env.DB.prepare("SELECT * FROM emails WHERE id = ?")
    .bind(ev.email_id)
    .first<EmailDbRow>();

  if (!row) return null;
  const email = rowToEmail(row);
  const type = WEBHOOK_EVENT[ev.type];

  if (!type) return null;
  const extra = ev.data ? eventData(ev.data) : {};

  const data: JsonObject = {
    created_at: iso(email.createdAt),
    email_id: email.id,
    from: email.from,
    to: email.to,
    subject: email.subject,
    message_id: email.cfMessageId ?? undefined,
  };

  if (email.tags?.length) {
    data.tags = Object.fromEntries(email.tags.map((t) => [t.name, t.value]));
  }

  if (ev.type === "bounced") {
    const bounce = isJsonObject(extra.bounce) ? extra.bounce : {};

    data.bounce = {
      message: bounce.reason ?? "",
      type: bounce.type === "hard" ? "Permanent" : "Transient",
      subType: bounce.classification ?? "General",
    };
  }

  if (ev.type === "clicked") {
    data.click = {
      ipAddress: extra.ip ?? "",
      link: extra.link ?? "",
      timestamp: iso(ev.created_at),
      userAgent: extra.user_agent ?? "",
    };
  }

  if (ev.type === "failed") {
    data.failed = {
      reason: extra.reason ?? email.error ?? "",
    };
  }

  if (ev.type === "suppressed") {
    data.suppressed = {
      message: "Every recipient is on the suppression list.",
      type: "OnAccountSuppressionList",
    };
  }

  return {
    type,
    body: JSON.stringify({ type, created_at: iso(ev.created_at), data }),
  };
}

// The `data` of a test event. It has the shape of the Resend SDK for the
// type, so a receiver can parse it.
function testData(type: string, now: string): JsonObject {
  if (type.startsWith("domain.")) {
    return {
      id: "00000000-0000-0000-0000-000000000000",
      name: "example.com",
      status: "verified",
      created_at: now,
      region: "global",
      records: [],
      test: true,
    };
  }

  if (type.startsWith("suppression.")) {
    return {
      id: "sup_test",
      email: "delivered@example.com",
      origin: "manual",
      source_id: null,
      created_at: now,
      test: true,
    };
  }

  return {
    created_at: now,
    email_id: "00000000-0000-0000-0000-000000000000",
    from: "fullsend <test@example.com>",
    to: ["delivered@example.com"],
    subject: "fullsend test event",
    test: true,
  };
}

export function testBody(type = "email.sent"): string {
  const now = new Date().toISOString();

  return JSON.stringify({ type, created_at: now, data: testData(type, now) });
}
