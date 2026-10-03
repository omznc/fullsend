import { ensureSubscription, listDomains, syncDomain } from "./domains/service";
import type { Env, SendMessage } from "./env";
import { hasToken } from "./lib/cloudflare";
import { getSettings } from "./lib/settings";
import { errorText, logSystemEvent } from "./lib/system-events";
import { DAY } from "./lib/time";
import { type EmailDbRow, fail, rowToEmail } from "./send/consumer";

// One cron runs each minute. Each minute it sends due scheduled emails
// and sweeps the emails that stay in the send queue. It syncs the
// domains each 15 minutes. It deletes old data each hour.
export async function runCron(
  controller: ScheduledController,
  env: Env,
): Promise<void> {
  const at = new Date(controller.scheduledTime);

  const jobs = new Map<string, Promise<unknown>>([
    [
      "dispatch",
      dispatchScheduled(env, at.getTime()).then(() =>
        sweepStuck(env, at.getTime()),
      ),
    ],
  ]);

  if (at.getUTCMinutes() % 15 === 0) jobs.set("domains", syncDomains(env));

  if (at.getUTCMinutes() === RETENTION_MINUTE)
    jobs.set("retention", retention(env, at.getTime()));

  const results = await Promise.allSettled(jobs.values());
  const names = [...jobs.keys()];

  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      await logSystemEvent(env, {
        level: "error",
        source: "cron",
        message: "A cron job failed.",
        detail: { job: names[i] ?? "", error: errorText(r.reason) },
      });
    }
  }
}

// Retention runs at this minute of each hour. A run that stops at its
// budget leaves work for the next hour.
const RETENTION_MINUTE = 7;

// Puts the scheduled emails that are due in the next minute on the send
// queue, with a delay to their exact time.
export async function dispatchScheduled(
  env: Env,
  now = Date.now(),
): Promise<number> {
  const { results } = await env.DB.prepare(
    `UPDATE emails SET dispatched_at = ?1 WHERE id IN (
       SELECT id FROM emails WHERE status = 'scheduled' AND dispatched_at IS NULL AND scheduled_at <= ?2 LIMIT 500
     ) RETURNING id, scheduled_at`,
  )
    .bind(now, now + 60_000)
    .all<{ id: string; scheduled_at: number }>();

  const messages: MessageSendRequest<SendMessage>[] = results.map((r) => ({
    body: { emailId: r.id },
    delaySeconds: Math.max(0, Math.ceil((r.scheduled_at - now) / 1000)),
  }));

  let sent = 0;

  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);

    try {
      await env.SEND_QUEUE.sendBatch(chunk);
      sent += chunk.length;
    } catch (err) {
      // Clear the mark, so the next run puts these emails on the queue.
      await logSystemEvent(env, {
        level: "error",
        source: "cron",
        message: "The cron could not put scheduled emails on the send queue.",
        detail: {
          ids: chunk.map((m) => m.body.emailId),
          error: errorText(err),
        },
      });
      await env.DB.batch(
        chunk.map((m) =>
          env.DB.prepare(
            "UPDATE emails SET dispatched_at = NULL WHERE id = ?",
          ).bind(m.body.emailId),
        ),
      );
    }
  }

  return sent;
}

// The send queue gives up well inside 30 minutes: the consumer fails the
// email after 5 attempts, the backoff is 600 seconds at most, and a claim
// retry waits 120 seconds. A pending email that is older than this is not
// in the queue any more.
export const STUCK_AFTER = 30 * 60_000;

// The sweep puts an email back on the queue this many times. Then it
// fails the email.
const MAX_SWEEPS = 3;

const SWEEP_LIMIT = 100;

const PENDING_STATUS = "status IN ('queued', 'scheduled')";

// A pending email with no Cloudflare message id and no claim. `dispatched_at`
// is the time of the last put on the queue: the cron sets it for a
// scheduled email and the sweep sets it for each email. So the sweep does
// not put an email back each minute.
const STUCK_UNCLAIMED = `${PENDING_STATUS} AND cf_message_id IS NULL AND claimed_at IS NULL AND (
  (status = 'queued' AND COALESCE(dispatched_at, created_at) < ?1)
  OR (status = 'scheduled' AND dispatched_at IS NOT NULL AND dispatched_at < ?1))`;

export interface SweepResult {
  recorded: number;
  requeued: number;
  failed: number;
  uncertain: number;
}

interface Swept {
  id: string;
  scheduled_at: number | null;
  status: string;
}

// Puts emails on the send queue again, in chunks. When a chunk fails, the
// `undo` statement runs for each of its ids, so a later run finds the
// emails again. Returns the ids that are on the queue.
async function enqueueAgain(
  env: Env,
  rows: Swept[],
  now: number,
  undo: string,
): Promise<string[]> {
  const done: string[] = [];

  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);

    const messages: MessageSendRequest<SendMessage>[] = chunk.map((r) => {
      const message: MessageSendRequest<SendMessage> = {
        body: { emailId: r.id },
      };

      if (r.status === "scheduled") {
        message.delaySeconds = Math.max(
          0,
          Math.ceil(((r.scheduled_at ?? now) - now) / 1000),
        );
      }

      return message;
    });

    try {
      await env.SEND_QUEUE.sendBatch(messages);
      done.push(...chunk.map((r) => r.id));
    } catch (err) {
      await logSystemEvent(env, {
        level: "error",
        source: "sweep",
        message: "The sweep could not put emails on the send queue.",
        detail: {
          ids: chunk.map((r) => r.id),
          error: errorText(err),
        },
      });
      await env.DB.batch(
        chunk.map((r) => env.DB.prepare(undo).bind(r.id)),
      ).catch((e) =>
        logSystemEvent(env, {
          level: "error",
          source: "sweep",
          message: "The sweep could not undo its mark after a queue failure.",
          detail: { ids: chunk.map((r) => r.id), error: errorText(e) },
        }),
      );
    }
  }

  return done;
}

// Finds the pending emails that the send queue lost or that a consumer
// did not finish. Each run handles 100 emails of each kind at most.
//
// Each change is one UPDATE with the checks in its WHERE clause. An email
// that changed since the SELECT is not touched.
export async function sweepStuck(
  env: Env,
  now = Date.now(),
): Promise<SweepResult> {
  const cutoff = now - STUCK_AFTER;

  const result: SweepResult = {
    recorded: 0,
    requeued: 0,
    failed: 0,
    uncertain: 0,
  };

  // a. Cloudflare accepted the email, but the sent event is not recorded.
  // The consumer sees `cf_message_id`, records the event and does not send.
  const sentRows = await env.DB.prepare(
    `UPDATE emails SET dispatched_at = ?2 WHERE id IN (
       SELECT id FROM emails WHERE ${PENDING_STATUS} AND cf_message_id IS NOT NULL
         AND sent_at < ?1 AND COALESCE(dispatched_at, 0) < ?1 LIMIT ${SWEEP_LIMIT}
     ) AND ${PENDING_STATUS} AND cf_message_id IS NOT NULL
     RETURNING id, scheduled_at, status`,
  )
    .bind(cutoff, now)
    .all<Swept>();

  const recorded = await enqueueAgain(
    env,
    sentRows.results,
    now,
    "UPDATE emails SET dispatched_at = NULL WHERE id = ?",
  );

  result.recorded = recorded.length;

  if (recorded.length) {
    await logSystemEvent(env, {
      level: "warn",
      source: "sweep",
      message: "The sweep put sent emails on the queue to record the event.",
      detail: { ids: recorded },
    });
  }

  // b. The email never reached a consumer. Put it back on the queue. After
  // MAX_SWEEPS times, fail it.
  const again = await env.DB.prepare(
    `UPDATE emails SET sweep_count = sweep_count + 1, dispatched_at = ?2 WHERE id IN (
       SELECT id FROM emails WHERE ${STUCK_UNCLAIMED} AND sweep_count < ${MAX_SWEEPS} LIMIT ${SWEEP_LIMIT}
     ) AND ${STUCK_UNCLAIMED} AND sweep_count < ${MAX_SWEEPS}
     RETURNING id, scheduled_at, status`,
  )
    .bind(cutoff, now)
    .all<Swept>();

  const requeued = await enqueueAgain(
    env,
    again.results,
    now,
    "UPDATE emails SET sweep_count = MAX(sweep_count - 1, 0), dispatched_at = NULL WHERE id = ?",
  );

  result.requeued = requeued.length;

  if (requeued.length) {
    await logSystemEvent(env, {
      level: "warn",
      source: "sweep",
      message: "The sweep put stuck emails on the send queue again.",
      detail: { ids: requeued },
    });
  }

  // The claim makes the email private to the sweep: a consumer cannot take
  // it, and the claim guard in the WHERE clause stops a second sweep.
  const exhausted = await env.DB.prepare(
    `UPDATE emails SET claimed_at = ?2 WHERE id IN (
       SELECT id FROM emails WHERE ${STUCK_UNCLAIMED} AND sweep_count >= ${MAX_SWEEPS} LIMIT ${SWEEP_LIMIT}
     ) AND ${STUCK_UNCLAIMED} AND sweep_count >= ${MAX_SWEEPS}
     RETURNING *`,
  )
    .bind(cutoff, now)
    .all<EmailDbRow>();

  result.failed = await failAll(
    env,
    exhausted.results,
    "The email stayed in the send queue and the sweep could not send it.",
    "The sweep failed emails that stayed in the send queue.",
  );

  // c. A consumer took the email and stopped. This can be during
  // EMAIL.send, so the email can be sent already. Never put it back on
  // the queue: that can send it a second time.
  const claimed = await env.DB.prepare(
    `UPDATE emails SET claimed_at = ?2 WHERE id IN (
       SELECT id FROM emails WHERE ${PENDING_STATUS} AND cf_message_id IS NULL
         AND claimed_at IS NOT NULL AND claimed_at < ?1 LIMIT ${SWEEP_LIMIT}
     ) AND ${PENDING_STATUS} AND cf_message_id IS NULL
       AND claimed_at IS NOT NULL AND claimed_at < ?1
     RETURNING *`,
  )
    .bind(cutoff, now)
    .all<EmailDbRow>();

  result.uncertain = await failAll(
    env,
    claimed.results,
    "The send stopped before it finished. The email can be sent already. Check before you send it again.",
    "The sweep failed emails with an unfinished send. They can be sent already.",
  );

  return result;
}

// Fails each email through the same path as the send consumer, so the
// failed event and the email.failed webhook happen. One email that fails
// to record does not stop the others.
async function failAll(
  env: Env,
  rows: EmailDbRow[],
  reason: string,
  message: string,
): Promise<number> {
  const ids: string[] = [];

  for (const row of rows) {
    try {
      await fail(env, rowToEmail(row), reason);
      ids.push(row.id);
    } catch (err) {
      await logSystemEvent(env, {
        level: "error",
        source: "sweep",
        message: "The sweep could not record a failed email.",
        detail: { id: row.id, error: errorText(err) },
      });
    }
  }

  if (rows.length) {
    await logSystemEvent(env, {
      level: "error",
      source: "sweep",
      message,
      detail: { ids, reason },
    });
  }

  return ids.length;
}

async function syncDomains(env: Env): Promise<void> {
  if (!hasToken(env)) return;

  for (const row of await listDomains(env)) {
    try {
      const synced = await syncDomain(env, row);

      if (!synced.eventSubscriptionId) await ensureSubscription(env, synced);
    } catch (err) {
      await logSystemEvent(env, {
        level: "warn",
        source: "cron",
        message: "A domain sync failed.",
        detail: { domain: row.name, error: errorText(err) },
      });
    }
  }
}

// Retention keeps an email that is not sent yet. A scheduled email can
// be older than the retention period.
const PENDING = "('queued', 'scheduled')";

// Retention keeps the system events and the API request log this long.
export const SYSTEM_EVENTS_KEEP = 30 * DAY;

export const API_REQUESTS_KEEP = 14 * DAY;

// One round handles this many rows. A query with a list of ids reads the
// list as one JSON text, because D1 allows 100 bound values at most.
const CHUNK = 500;

// Each step runs this many rounds at most, and the whole run stops at the
// time budget. The next run does the rest.
const MAX_ROUNDS = 20;

const TIME_BUDGET_MS = 20_000;

export interface RetentionResult {
  rounds: number;
  // False when a step stopped at its budget and rows can remain.
  complete: boolean;
}

interface BodyRow {
  id: string;
  body_key: string | null;
}

export async function retention(
  env: Env,
  now = Date.now(),
): Promise<RetentionResult> {
  const s = await getSettings(env);
  const bodyCutoff = now - Number(s.body_retention_days) * DAY;
  const rowCutoff = now - Number(s.row_retention_days) * DAY;
  const deadline = Date.now() + TIME_BUDGET_MS;
  const result: RetentionResult = { rounds: 0, complete: true };

  // Runs a round again while it has full chunks. A round returns the
  // number of rows that it handled.
  const loop = async (round: () => Promise<number>) => {
    for (let i = 0; i < MAX_ROUNDS; i++) {
      if (Date.now() >= deadline) {
        result.complete = false;

        return;
      }

      result.rounds++;

      if ((await round()) < CHUNK) return;
    }

    result.complete = false;
  };

  const step = async (name: string, round: () => Promise<number>) => {
    try {
      await loop(round);
    } catch (err) {
      // A failed step does not stop the other steps.
      result.complete = false;
      await logSystemEvent(env, {
        level: "error",
        source: "cron",
        message: "A retention step failed.",
        detail: { step: name, error: errorText(err) },
      });
    }
  };

  // The R2 bodies of the old emails go first. A row that stays after its
  // body is gone is safe: the body is missing, not the row.
  await step("bodies", async () => {
    const { results } = await env.DB.prepare(
      `SELECT id, body_key FROM emails WHERE body_key IS NOT NULL AND created_at < ?
       AND status NOT IN ${PENDING} LIMIT ${CHUNK}`,
    )
      .bind(bodyCutoff)
      .all<BodyRow>();

    await deleteBodies(env, results);

    if (results.length) {
      await env.DB.prepare(
        "UPDATE emails SET body_key = NULL WHERE id IN (SELECT value FROM json_each(?))",
      )
        .bind(JSON.stringify(results.map((r) => r.id)))
        .run();
    }

    return results.length;
  });

  // The R2 bodies go before their rows. Without the rows, nothing
  // points to the bodies, and they stay in R2 for ever.
  await step("emails", async () => {
    const { results } = await env.DB.prepare(
      `SELECT id, body_key FROM emails WHERE created_at < ?
       AND status NOT IN ${PENDING} LIMIT ${CHUNK}`,
    )
      .bind(rowCutoff)
      .all<BodyRow>();

    if (!results.length) return 0;

    await deleteBodies(env, results);

    const ids = JSON.stringify(results.map((r) => r.id));

    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM email_events WHERE email_id IN (SELECT value FROM json_each(?))",
      ).bind(ids),
      env.DB.prepare(
        "DELETE FROM emails WHERE id IN (SELECT value FROM json_each(?))",
      ).bind(ids),
    ]);

    return results.length;
  });

  const oldRows = (
    name: string,
    table: string,
    where: string,
    ...bind: number[]
  ) =>
    step(name, async () => {
      const done = await env.DB.prepare(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${CHUNK})`,
      )
        .bind(...bind)
        .run();

      return done.meta.changes;
    });

  await oldRows(
    "webhook_deliveries",
    "webhook_deliveries",
    "created_at < ?",
    rowCutoff,
  );
  await oldRows(
    "idempotency_keys",
    "idempotency_keys",
    "created_at < ?",
    now - DAY,
  );
  await oldRows(
    "auth_attempts",
    "auth_attempts",
    "updated_at < ?1 AND locked_until < ?2",
    now - DAY,
    now,
  );
  await oldRows(
    "system_events",
    "system_events",
    "created_at < ?",
    now - SYSTEM_EVENTS_KEEP,
  );
  await oldRows(
    "api_requests",
    "api_requests",
    "created_at < ?",
    now - API_REQUESTS_KEEP,
  );

  return result;
}

// Deletes the R2 objects of the rows that have a body key.
async function deleteBodies(env: Env, rows: BodyRow[]): Promise<void> {
  const keys = rows.flatMap((r) => (r.body_key ? [r.body_key] : []));

  if (keys.length) await env.BODIES.delete(keys);
}
