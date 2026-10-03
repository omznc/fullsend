import type { Env, HookMessage } from "../env";
import { ApiError, notFound, validation } from "../lib/errors";
import { type JsonValue, parseJsonText } from "../lib/json";
import { type Page, pageQuery } from "../lib/page";
import { iso } from "../lib/time";
import { MAX_ATTEMPTS, RETRY_DELAYS } from "./deliver";
import { getWebhook } from "./service";

// The webhook events of the Resend API. One event is one message: the
// attempts of one svix-id are the rows of `webhook_deliveries` with the
// same `message_id`. The id of an event is the message id.

type EventStatus = "success" | "pending" | "failed" | "attempting";

interface AttemptRow {
  id: string;
  message_id: string;
  event_id: string | null;
  event_type: string;
  attempt: number;
  status_code: number | null;
  request_body: string;
  response_excerpt: string | null;
  error: string | null;
  created_at: number;
}

// The state of an event after its last stored attempt. A message with no
// attempt row is not stored, so "pending" never shows here.
function statusOf(last: AttemptRow): EventStatus {
  const ok =
    last.status_code !== null &&
    last.status_code >= 200 &&
    last.status_code < 300;

  if (ok) return "success";

  // The last delay is used. The queue sends no more attempts.
  return last.attempt > RETRY_DELAYS.length ? "failed" : "attempting";
}

// When the queue sends the next attempt, from the last attempt.
function nextAttemptAt(last: AttemptRow): string | null {
  if (statusOf(last) !== "attempting") return null;
  const delay = RETRY_DELAYS[last.attempt - 1];

  return delay === undefined ? null : iso(last.created_at + delay * 1000);
}

// The attempts of the events in the list, newest first, for each event.
async function lastAttempts(
  env: Env,
  webhookId: string,
  messageIds: string[],
): Promise<Map<string, { first: AttemptRow; last: AttemptRow }>> {
  const out = new Map<string, { first: AttemptRow; last: AttemptRow }>();

  if (!messageIds.length) return out;

  // The ids go in as one JSON text, because D1 allows 100 bound values at
  // most.
  const { results } = await env.DB.prepare(
    `SELECT * FROM webhook_deliveries
     WHERE webhook_id = ? AND message_id IN (SELECT value FROM json_each(?))
     ORDER BY created_at ASC, attempt ASC, id ASC`,
  )
    .bind(webhookId, JSON.stringify(messageIds))
    .all<AttemptRow>();

  for (const row of results) {
    const hit = out.get(row.message_id);
    out.set(row.message_id, { first: hit?.first ?? row, last: row });
  }

  return out;
}

async function firstAttemptAt(
  env: Env,
  webhookId: string,
  messageId: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT MIN(created_at) AS at FROM webhook_deliveries WHERE webhook_id = ? AND message_id = ?",
  )
    .bind(webhookId, messageId)
    .first<{ at: number | null }>();

  return row?.at ?? null;
}

export interface EventLog {
  id: string;
  type: string;
  created_at: string;
  status: EventStatus;
}

// One page of the events of a webhook, newest first. The cursor is an
// event id.
export async function listEvents(
  env: Env,
  webhookId: string,
  page: Page,
): Promise<{ data: EventLog[]; has_more: boolean }> {
  await getWebhook(env, webhookId);
  const limit = page.limit ?? 20;
  const cursorId = page.after ?? page.before;
  const having: string[] = [];
  const binds: (string | number)[] = [webhookId];

  if (cursorId) {
    const at = await firstAttemptAt(env, webhookId, cursorId);

    if (at === null) {
      throw new ApiError(
        422,
        "invalid_parameter",
        "The cursor id does not exist.",
      );
    }

    having.push(
      page.after
        ? "(MIN(created_at), message_id) < (?, ?)"
        : "(MIN(created_at), message_id) > (?, ?)",
    );
    binds.push(at, cursorId);
  }

  const order = page.before ? "ASC" : "DESC";

  const { results } = await env.DB.prepare(
    `SELECT message_id AS id, MIN(created_at) AS created_at
     FROM webhook_deliveries WHERE webhook_id = ?
     GROUP BY message_id ${having.length ? `HAVING ${having.join(" AND ")}` : ""}
     ORDER BY MIN(created_at) ${order}, message_id ${order} LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<{ id: string; created_at: number }>();

  const rows = results.slice(0, limit);

  if (page.before) rows.reverse();

  const attempts = await lastAttempts(
    env,
    webhookId,
    rows.map((r) => r.id),
  );

  return {
    has_more: results.length > limit,
    data: rows.flatMap((r) => {
      const hit = attempts.get(r.id);

      return hit
        ? [
            {
              id: r.id,
              type: hit.first.event_type,
              created_at: iso(r.created_at),
              status: statusOf(hit.last),
            },
          ]
        : [];
    }),
  };
}

export interface EventDetail extends EventLog {
  next_attempt_at: string | null;
  payload: JsonValue;
}

export async function getEvent(
  env: Env,
  webhookId: string,
  eventId: string,
): Promise<EventDetail> {
  await getWebhook(env, webhookId);
  const hit = (await lastAttempts(env, webhookId, [eventId])).get(eventId);

  if (!hit) throw notFound("Webhook event");

  return {
    id: eventId,
    type: hit.first.event_type,
    created_at: iso(hit.first.created_at),
    status: statusOf(hit.last),
    next_attempt_at: nextAttemptAt(hit.last),
    payload: parseJsonText(hit.first.request_body),
  };
}

export interface AttemptLog {
  id: string;
  http_status_code: number;
  response: string;
  sent_at: string;
}

// One page of the attempts of an event, newest first. The status code is 0
// when the request did not get a response. The response text is then the
// error.
export async function listAttempts(
  env: Env,
  webhookId: string,
  eventId: string,
  page: Page,
): Promise<{ data: AttemptLog[]; has_more: boolean }> {
  await getEvent(env, webhookId, eventId);

  const { rows, has_more } = await pageQuery<AttemptRow>(
    env,
    "webhook_deliveries",
    ["webhook_id = ?", "message_id = ?"],
    [webhookId, eventId],
    page,
  );

  return {
    has_more,
    data: rows.map((r) => ({
      id: r.id,
      http_status_code: r.status_code ?? 0,
      response: r.response_excerpt ?? r.error ?? "",
      sent_at: iso(r.created_at),
    })),
  };
}

// Puts an event on the hooks queue again. The message has the stored body
// and the same svix-id, so the receiver sees the same event.
export async function replayEvent(
  env: Env,
  webhookId: string,
  eventId: string,
): Promise<void> {
  const hook = await getWebhook(env, webhookId);
  const hit = (await lastAttempts(env, webhookId, [eventId])).get(eventId);

  if (!hit) throw notFound("Webhook event");

  if (hook.status !== "enabled") {
    throw validation("The webhook is disabled. Enable it to replay an event.");
  }

  await env.HOOKS_QUEUE.send(replayMessage(webhookId, eventId, hit.first));
}

// The queue message that sends an event again.
const replayMessage = (
  webhookId: string,
  messageId: string,
  first: AttemptRow,
): HookMessage => ({
  webhookId,
  messageId,
  eventId: first.event_id,
  body: first.request_body,
});

// The most events that one call of replayFailed sends again.
export const MAX_REPLAY = 500;

// The messages in one sendBatch call. The queue allows 100 messages and
// 256 KB at most, and a stored body can be large.
const REPLAY_CHUNK = 20;

// Puts the failed events of a webhook on the hooks queue again. An event
// is failed when its last attempt used the last delay and still failed,
// and that attempt is not older than `since` (epoch milliseconds). An event
// that the queue still retries is left alone. The call sends the newest
// MAX_REPLAY events, and `more` says that others are left.
export async function replayFailed(
  env: Env,
  webhookId: string,
  since: number,
): Promise<{ queued: number; more: boolean }> {
  const hook = await getWebhook(env, webhookId);

  if (hook.status !== "enabled") {
    throw validation("The webhook is disabled. Enable it to replay events.");
  }

  const { results } = await env.DB.prepare(
    `SELECT d.message_id FROM webhook_deliveries d
     WHERE d.webhook_id = ?1 AND d.created_at >= ?2 AND d.attempt >= ?3
       AND (d.status_code IS NULL OR d.status_code < 200 OR d.status_code > 299)
       AND NOT EXISTS (
         SELECT 1 FROM webhook_deliveries x
         WHERE x.webhook_id = d.webhook_id AND x.message_id = d.message_id
           AND (x.created_at > d.created_at
             OR (x.created_at = d.created_at AND x.id > d.id)))
     GROUP BY d.message_id ORDER BY MAX(d.created_at) DESC LIMIT ?4`,
  )
    .bind(webhookId, since, MAX_ATTEMPTS, MAX_REPLAY + 1)
    .all<{ message_id: string }>();

  const ids = results.slice(0, MAX_REPLAY).map((r) => r.message_id);
  const found = await lastAttempts(env, webhookId, ids);
  const messages: { body: HookMessage }[] = [];

  for (const id of ids) {
    const hit = found.get(id);

    if (hit) messages.push({ body: replayMessage(webhookId, id, hit.first) });
  }

  for (let i = 0; i < messages.length; i += REPLAY_CHUNK) {
    await env.HOOKS_QUEUE.sendBatch(messages.slice(i, i + REPLAY_CHUNK));
  }

  return { queued: messages.length, more: results.length > MAX_REPLAY };
}
