import { z } from "zod";
import type { EmailStatus } from "../db/schema";
import type { Env } from "../env";
import { normalize } from "../lib/address";
import { recordEvent } from "./record";

// An Email Sending event from the Queues event subscription. The schema
// checks only the fields that fullsend reads. `catchall` keeps the other
// fields as JSON, because the event data stores the full objects.
const cfEmailEvent = z.object({
  // "cf.email.sending.message.<kind>"
  type: z.string(),
  source: z.object({}).catchall(z.json()).optional(),
  payload: z
    .object({
      eventId: z.string().optional(),
      messageId: z.string(),
      recipient: z.string().optional(),
      // Also status, provider, deliveryTimeMs, smtpStatusCode and
      // smtpEnhancedStatusCode.
      delivery: z
        .object({ smtpResponse: z.string().optional() })
        .catchall(z.json())
        .optional(),
      // Also classification.
      bounce: z
        .object({ type: z.string().optional(), reason: z.string().optional() })
        .catchall(z.json())
        .optional(),
      complaint: z.object({}).catchall(z.json()).optional(),
    })
    .catchall(z.json()),
  metadata: z
    .object({ eventTimestamp: z.string().optional() })
    .catchall(z.json())
    .optional(),
});

export type CfEmailEvent = z.input<typeof cfEmailEvent>;

const STATUS = new Map<string, EmailStatus>([
  ["delivered", "delivered"],
  ["deferred", "delivery_delayed"],
  ["bounced", "bounced"],
  ["failed", "failed"],
  ["rejected", "failed"],
  ["complained", "complained"],
]);

// An event can arrive before the send consumer stored the message id.
// The consumer tries again this many times, then drops the event.
const MAX_WAIT_ATTEMPTS = 8;

export async function handleEventsBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const event = cfEmailEvent.safeParse(msg.body);

      if (!event.success) {
        console.warn("unknown event", msg.body);
        msg.ack();
        continue;
      }

      const done = await handleEvent(env, event.data);

      if (done || msg.attempts >= MAX_WAIT_ATTEMPTS) {
        if (!done) console.warn("event for unknown message dropped", msg.body);
        msg.ack();
      } else {
        msg.retry({ delaySeconds: Math.min(300, 5 * 2 ** msg.attempts) });
      }
    } catch (err) {
      console.error("events consumer error", err);
      msg.retry({ delaySeconds: 30 });
    }
  }
}

// Returns false when no email has the message id yet.
export async function handleEvent(
  env: Env,
  event: CfEmailEvent,
): Promise<boolean> {
  const kind = event.type.replace(/^cf\.email\.sending\.message\./, "");
  const type = kind ? STATUS.get(kind) : undefined;

  if (!type || !event.payload.messageId) {
    console.warn("unknown event", event.type);

    return true;
  }

  const p = event.payload;

  const email = await env.DB.prepare(
    "SELECT id FROM emails WHERE cf_message_id = ?",
  )
    .bind(p.messageId)
    .first<{ id: string }>();

  if (!email) return false;

  const at = event.metadata?.eventTimestamp
    ? Date.parse(event.metadata.eventTimestamp)
    : Date.now();

  const reason =
    p.bounce?.reason ??
    p.delivery?.smtpResponse ??
    (kind === "rejected" ? "Rejected by Cloudflare" : null);

  const error = type === "bounced" || type === "failed" ? reason : null;

  await recordEvent(env, email.id, {
    type,
    recipient: p.recipient ?? null,
    at: Number.isNaN(at) ? Date.now() : at,
    cfEventId: p.eventId ?? `${p.messageId}:${kind}:${p.recipient ?? ""}`,
    data: {
      cf_type: kind,
      delivery: p.delivery ?? null,
      bounce: p.bounce ?? null,
      complaint: p.complaint ?? null,
    },
    error,
  });

  // A hard bounce or a complaint adds the address to the suppression list.
  // The insert does nothing for an address that is on the list, so a
  // duplicate event does no harm.
  const hard = type === "bounced" && p.bounce?.type === "hard";

  if (p.recipient && (hard || type === "complained")) {
    await env.DB.prepare(
      `INSERT INTO suppressions (address, reason, source, email_id, created_at)
       VALUES (?, ?, 'cloudflare_event', ?, ?) ON CONFLICT (address) DO NOTHING`,
    )
      .bind(
        normalize(p.recipient),
        hard ? "hard_bounce" : "complaint",
        email.id,
        Date.now(),
      )
      .run();
  }

  return true;
}
