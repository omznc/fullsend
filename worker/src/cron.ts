import { ensureSubscription, listDomains, syncDomain } from "./domains/service";
import type { Env, SendMessage } from "./env";
import { hasToken } from "./lib/cloudflare";
import { getSettings } from "./lib/settings";
import { DAY } from "./lib/time";

// One cron runs each minute. It sends due scheduled emails each minute,
// syncs the domains each 15 minutes, and deletes old data each day.
export async function runCron(
  controller: ScheduledController,
  env: Env,
): Promise<void> {
  const at = new Date(controller.scheduledTime);
  const jobs: Promise<unknown>[] = [dispatchScheduled(env, at.getTime())];

  if (at.getUTCMinutes() % 15 === 0) jobs.push(syncDomains(env));

  if (at.getUTCHours() === 3 && at.getUTCMinutes() === 0)
    jobs.push(retention(env, at.getTime()));
  const results = await Promise.allSettled(jobs);

  for (const r of results)
    if (r.status === "rejected") console.error("cron job failed", r.reason);
}

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
      console.error("dispatch failed", err);
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

async function syncDomains(env: Env): Promise<void> {
  if (!hasToken(env)) return;

  for (const row of await listDomains(env)) {
    try {
      const synced = await syncDomain(env, row);

      if (!synced.eventSubscriptionId) await ensureSubscription(env, synced);
    } catch (err) {
      console.warn("domain sync failed", row.name, err);
    }
  }
}

// Retention keeps an email that is not sent yet. A scheduled email can
// be older than the retention period.
const PENDING = "('queued', 'scheduled')";

export async function retention(env: Env, now = Date.now()): Promise<void> {
  const s = await getSettings(env);
  const bodyCutoff = now - Number(s.body_retention_days) * DAY;
  const rowCutoff = now - Number(s.row_retention_days) * DAY;

  for (let round = 0; round < 20; round++) {
    const { results } = await env.DB.prepare(
      `SELECT id, body_key FROM emails WHERE body_key IS NOT NULL AND created_at < ?
       AND status NOT IN ${PENDING} LIMIT 500`,
    )
      .bind(bodyCutoff)
      .all<{ id: string; body_key: string }>();

    if (!results.length) break;
    await env.BODIES.delete(results.map((r) => r.body_key));
    await env.DB.batch(
      results.map((r) =>
        env.DB.prepare("UPDATE emails SET body_key = NULL WHERE id = ?").bind(
          r.id,
        ),
      ),
    );
  }

  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM email_events WHERE email_id IN (
         SELECT id FROM emails WHERE created_at < ? AND status NOT IN ${PENDING}
       )`,
    ).bind(rowCutoff),
    env.DB.prepare(
      `DELETE FROM emails WHERE created_at < ? AND status NOT IN ${PENDING}`,
    ).bind(rowCutoff),
    env.DB.prepare("DELETE FROM webhook_deliveries WHERE created_at < ?").bind(
      rowCutoff,
    ),
    env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").bind(
      now - DAY,
    ),
    env.DB.prepare(
      "DELETE FROM auth_attempts WHERE updated_at < ?1 AND locked_until < ?2",
    ).bind(now - DAY, now),
  ]);
}
