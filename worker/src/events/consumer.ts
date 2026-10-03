import { z } from "zod";
import type { EmailStatus } from "../db/schema";
import type { Env } from "../env";
import { normalize } from "../lib/address";
import { errorText, logSystemEvent } from "../lib/system-events";
import { addSuppressions } from "../suppressions/service";
import { type Hook, loadHooks, recordEvent } from "./record";

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

// The max_retries value of the fullsend-events queue in wrangler.jsonc.
// This value must match it. At this attempt the consumer stores the event
// in system_events and acks it, so the queue does not drop it.
const MAX_RETRIES = 10;

// The part of a message that the batch needs before the handler runs.
interface Parsed {
  msg: Message<unknown>;
  event: CfEmailEvent | null;
}

// Handles the batch. The events of one email run in order. The groups of
// different emails run at the same time. The batch reads the webhooks one
// time.
export async function handleEventsBatch(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const groups = new Map<string, Parsed[]>();

  for (const msg of batch.messages) {
    const parsed = cfEmailEvent.safeParse(msg.body);

    // A message that does not parse has no email key. It gets its own group.
    const key = parsed.success ? parsed.data.payload.messageId : msg.id;
    const list = groups.get(key) ?? [];

    list.push({ msg, event: parsed.success ? parsed.data : null });
    groups.set(key, list);
  }

  // A failed load is not an error here: each event then reads the
  // webhooks by itself.
  const hooks = await loadHooks(env).catch(() => undefined);

  await Promise.all(
    [...groups.values()].map(async (group) => {
      for (const item of group) await handleMessage(env, item, hooks);
    }),
  );
}

async function handleMessage(
  env: Env,
  { msg, event }: Parsed,
  hooks: Hook[] | undefined,
): Promise<void> {
  try {
    if (!event) {
      console.warn(JSON.stringify({ evt: "events.unparsable", id: msg.id }));

      return msg.ack();
    }

    const done = await handleEvent(env, event, hooks);

    if (done) return msg.ack();

    if (msg.attempts < MAX_WAIT_ATTEMPTS) {
      return msg.retry({ delaySeconds: Math.min(300, 5 * 2 ** msg.attempts) });
    }

    // The detail has the Cloudflare message id and the event type only.
    // The event has the recipient address.
    await logSystemEvent(env, {
      level: "warn",
      source: "events",
      message: "An event for an unknown message was dropped.",
      detail: { cfMessageId: event.payload.messageId, type: event.type },
    });
    msg.ack();
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "events.error",
        id: msg.id,
        attempts: msg.attempts,
        error: errorText(err),
      }),
    );

    if (msg.attempts < MAX_RETRIES) return msg.retry({ delaySeconds: 30 });

    // The last retry is used. Keep the payload for the owner and ack.
    const body = z.json().safeParse(msg.body);

    await logSystemEvent(env, {
      level: "error",
      source: "events",
      message: "An event failed after the last retry and was dropped.",
      detail: { error: errorText(err), attempts: msg.attempts },
      payload: body.success ? body.data : null,
    });
    msg.ack();
  }
}

// Returns false when no email has the message id yet.
export async function handleEvent(
  env: Env,
  event: CfEmailEvent,
  hooks?: Hook[],
): Promise<boolean> {
  const kind = event.type.replace(/^cf\.email\.sending\.message\./, "");
  const type = kind ? STATUS.get(kind) : undefined;

  if (!type || !event.payload.messageId) {
    console.warn(
      JSON.stringify({ evt: "events.unknown_type", type: event.type }),
    );

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

  await recordEvent(
    env,
    email.id,
    {
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
    },
    hooks,
  );

  // A hard bounce or a complaint adds the address to the suppression list.
  // The insert does nothing for an address that is on the list, so a
  // duplicate event does no harm and sends no suppression.added event.
  const hard = type === "bounced" && p.bounce?.type === "hard";

  if (p.recipient && (hard || type === "complained")) {
    await addSuppressions(
      env,
      [
        {
          address: normalize(p.recipient),
          reason: hard ? "hard_bounce" : "complaint",
          source: "cloudflare_event",
          emailId: email.id,
        },
      ],
      hooks,
    );
  }

  return true;
}
