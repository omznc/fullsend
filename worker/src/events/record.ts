import { z } from "zod";
import type { EmailStatus, emails } from "../db/schema";
import type { Env, HookMessage } from "../env";
import { type JsonObject, parseJsonText } from "../lib/json";
import { errorText, logSystemEvent } from "../lib/system-events";

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

// The webhook events that do not come from an email event. fullsend
// sends them from the code that changes the suppression list and the
// domain status.
const OTHER_EVENTS = [
  "suppression.added",
  "suppression.removed",
  "domain.updated",
];

// The events that fullsend sends. The dashboard offers these.
export const WEBHOOK_EVENTS: string[] = [
  ...Object.values(WEBHOOK_EVENT),
  ...OTHER_EVENTS,
];

// Each event type of the Resend SDK (`WebhookEvent`). A webhook can
// subscribe to each one. fullsend sends only the types in WEBHOOK_EVENTS.
// The rest have no source here: fullsend has no contacts, no topics and
// no receiving, and it does not send domain.created or domain.deleted.
export const ACCEPTED_WEBHOOK_EVENTS: readonly string[] = [
  "email.sent",
  "email.scheduled",
  "email.delivered",
  "email.delivery_delayed",
  "email.complained",
  "email.bounced",
  "email.opened",
  "email.clicked",
  "email.received",
  "email.failed",
  "email.suppressed",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.topics.updated",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "suppression.added",
  "suppression.removed",
  "topic.created",
  "topic.updated",
  "topic.deleted",
];

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
  hooks?: Hook[],
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

  await fanout(env, ev.type, [id], hooks);

  if (ev.cfEventId) {
    await env.DB.prepare("UPDATE email_events SET done = 1 WHERE id = ?")
      .bind(id)
      .run();
  }

  return id;
}

// The `events` column of a webhook.
const eventList = z.array(z.string());

// An enabled webhook and the events that it wants.
export interface Hook {
  id: string;
  events: string[];
}

export async function loadHooks(env: Env): Promise<Hook[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, events FROM webhooks WHERE status = 'enabled'",
  ).all<{ id: string; events: string }>();

  return results.map((r) => ({
    id: r.id,
    events: eventList.parse(parseJsonText(r.events)),
  }));
}

// Puts one message on the hooks queue for each webhook that wants the
// event. A caller that handles many events can pass the hooks that it
// loaded one time.
export async function fanout(
  env: Env,
  type: EmailStatus,
  eventIds: string[],
  loaded?: Hook[],
): Promise<void> {
  const name = WEBHOOK_EVENT[type];

  if (!name || !eventIds.length) return;

  const hooks = loaded ?? (await loadHooks(env));

  const messages: MessageSendRequest<HookMessage>[] = [];

  for (const hook of hooks) {
    if (!hook.events.includes(name)) continue;

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

// Sends a webhook event that has no email event row, to each enabled
// webhook that wants the type. The message holds the full body, as a test
// event does. It never throws: the caller has done its work, and a failed
// webhook must not undo it. A failure goes to the system events.
export async function emitEvent(
  env: Env,
  type: string,
  data: JsonObject,
  loaded?: Hook[],
): Promise<void> {
  try {
    const hooks = (loaded ?? (await loadHooks(env))).filter((h) =>
      h.events.includes(type),
    );

    if (!hooks.length) return;

    const body = JSON.stringify({
      type,
      created_at: new Date().toISOString(),
      data,
    });

    await env.HOOKS_QUEUE.sendBatch(
      hooks.map((hook) => ({
        body: {
          webhookId: hook.id,
          messageId: newMessageId(),
          eventId: null,
          body,
        },
      })),
    );
  } catch (err) {
    await logSystemEvent(env, {
      level: "warn",
      source: "hooks",
      message: "A webhook event could not be put on the queue.",
      detail: { type, error: errorText(err) },
    });
  }
}

export const newMessageId = () =>
  `msg_${crypto.randomUUID().replaceAll("-", "")}`;
