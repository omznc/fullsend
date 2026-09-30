import { z } from "zod";
import type { EmailStatus, emails } from "../db/schema";
import type { Env, HookMessage } from "../env";
import { type JsonObject, parseJsonText } from "../lib/json";

export type EmailRow = typeof emails.$inferSelect;

// The webhook event for each email event. Events that are not here send
// no webhook.
export const WEBHOOK_EVENT: Partial<Record<EmailStatus, string>> = {
  scheduled: "email.scheduled",
  sent: "email.sent",
  delivered: "email.delivered",
  delivery_delayed: "email.delivery_delayed",
  bounced: "email.bounced",
  complained: "email.complained",
  opened: "email.opened",
  clicked: "email.clicked",
  failed: "email.failed",
  suppressed: "email.suppressed",
};

export const WEBHOOK_EVENTS = Object.values(WEBHOOK_EVENT);

// The status column only moves forward. A delivered event for one
// recipient does not hide a bounce for another. Opens and clicks change
// `last_event`, not the status.
const RANK: Partial<Record<EmailStatus, number>> = {
  queued: 0,
  scheduled: 0,
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  bounced: 4,
  failed: 4,
  suppressed: 4,
  complained: 5,
  canceled: 6,
};

const rankSql = `CASE status ${Object.entries(RANK)
  .map(([s, r]) => `WHEN '${s}' THEN ${r}`)
  .join(" ")} ELSE 0 END`;

// The `data` column of an event: JSON that the webhook body reads.
export type EventData = JsonObject;

export interface NewEvent {
  type: EmailStatus;
  recipient?: string | null;
  data?: EventData | null;
  cfEventId?: string | null;
  at?: number;
  bot?: string | null;
  // A short reason for the email's `error` column.
  error?: string | null;
}

export function eventInsert(
  env: Env,
  emailId: string,
  ev: NewEvent,
  id: string,
) {
  return env.DB.prepare(
    `INSERT INTO email_events (id, email_id, recipient, type, data, bot, cf_event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
  ).bind(
    id,
    emailId,
    ev.recipient ?? null,
    ev.type,
    ev.data ? JSON.stringify(ev.data) : null,
    ev.bot ?? null,
    ev.cfEventId ?? null,
    ev.at ?? Date.now(),
  );
}

// Stores an event, updates the email, and sends the webhooks. Returns the
// event id, or null when the event is a duplicate.
//
// An event with a `cfEventId` is done only after its webhooks are on the
// queue. When a step fails, the retry finds the stored event and does the
// remaining steps again.
export async function recordEvent(
  env: Env,
  emailId: string,
  ev: NewEvent,
): Promise<string | null> {
  const at = ev.at ?? Date.now();

  const inserted = await eventInsert(
    env,
    emailId,
    { ...ev, at },
    crypto.randomUUID(),
  ).first<{ id: string }>();

  let id: string;

  if (inserted) {
    id = inserted.id;
  } else {
    if (!ev.cfEventId) return null;

    const prior = await env.DB.prepare(
      "SELECT id, done FROM email_events WHERE cf_event_id = ?",
    )
      .bind(ev.cfEventId)
      .first<{ id: string; done: number }>();

    if (!prior || prior.done) return null;
    id = prior.id;
  }

  if (ev.bot) return id;

  const rank = RANK[ev.type];

  const statusSql =
    rank === undefined
      ? "status"
      : `CASE WHEN ${rank} >= ${rankSql} THEN ?4 ELSE status END`;

  await env.DB.prepare(
    `UPDATE emails SET
       last_event = CASE WHEN ?2 >= last_event_at THEN ?4 ELSE last_event END,
       last_event_at = MAX(last_event_at, ?2),
       status = ${statusSql},
       error = COALESCE(?3, error)
     WHERE id = ?1`,
  )
    .bind(emailId, at, ev.error ?? null, ev.type)
    .run();

  await fanout(env, ev.type, [id]);

  if (ev.cfEventId) {
    await env.DB.prepare("UPDATE email_events SET done = 1 WHERE id = ?")
      .bind(id)
      .run();
  }

  return id;
}

// The `events` column of a webhook.
const eventList = z.array(z.string());

// Puts one message on the hooks queue for each webhook that wants the
// event.
export async function fanout(
  env: Env,
  type: EmailStatus,
  eventIds: string[],
): Promise<void> {
  const name = WEBHOOK_EVENT[type];

  if (!name || !eventIds.length) return;

  const { results } = await env.DB.prepare(
    "SELECT id, events FROM webhooks WHERE status = 'enabled'",
  ).all<{ id: string; events: string }>();

  const messages: MessageSendRequest<HookMessage>[] = [];

  for (const hook of results) {
    const wanted = eventList.parse(parseJsonText(hook.events));

    if (!wanted.includes(name)) continue;

    for (const eventId of eventIds) {
      messages.push({
        body: {
          webhookId: hook.id,
          messageId: newMessageId(),
          eventId,
          body: null,
        },
      });
    }
  }

  for (let i = 0; i < messages.length; i += 100) {
    await env.HOOKS_QUEUE.sendBatch(messages.slice(i, i + 100));
  }
}

export const newMessageId = () =>
  `msg_${crypto.randomUUID().replaceAll("-", "")}`;
