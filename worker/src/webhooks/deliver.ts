import { z } from "zod";
import type { Env, HookMessage } from "../env";
import { parseJsonText } from "../lib/json";
import { errorText, logSystemEvent } from "../lib/system-events";
import { buildEventBody } from "./payload";
import { sign } from "./sign";

// Delay before each retry, in seconds. The sum is about 27 hours.
const RETRY_DELAYS = [5, 300, 1800, 7200, 18000, 36000, 36000];

const TIMEOUT_MS = 15_000;

// The max_retries value of the fullsend-hooks queue in wrangler.jsonc.
// This value must match it. At this attempt the consumer stores the
// message in system_events and acks it, so the queue does not drop it.
const MAX_RETRIES = 8;

// The body of a test event (testBody in payload.ts). Only `type` is read.
const testEvent = z.object({ type: z.string() });

export async function handleHooksBatch(
  batch: MessageBatch<HookMessage>,
  env: Env,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (msg) => {
      try {
        const retry = await deliver(env, msg.body, msg.attempts);
        const delay = RETRY_DELAYS[msg.attempts - 1];

        if (retry && delay !== undefined) msg.retry({ delaySeconds: delay });
        else msg.ack();
      } catch (err) {
        console.error(
          JSON.stringify({
            evt: "hooks.error",
            webhookId: msg.body.webhookId,
            attempts: msg.attempts,
            error: errorText(err),
          }),
        );

        if (msg.attempts < MAX_RETRIES) return msg.retry({ delaySeconds: 60 });

        // The last retry is used. Keep the message for the owner and ack.
        await logSystemEvent(env, {
          level: "error",
          source: "hooks",
          message: "A webhook message failed after the last retry.",
          detail: {
            webhookId: msg.body.webhookId,
            error: errorText(err),
            attempts: msg.attempts,
          },
          payload: { ...msg.body },
        });
        msg.ack();
      }
    }),
  );
}

// Sends one attempt and stores it. Returns true when a retry can help.
export async function deliver(
  env: Env,
  m: HookMessage,
  attempt: number,
): Promise<boolean> {
  const hook = await env.DB.prepare(
    "SELECT id, endpoint, secret, status FROM webhooks WHERE id = ?",
  )
    .bind(m.webhookId)
    .first<{ id: string; endpoint: string; secret: string; status: string }>();

  if (!hook || hook.status !== "enabled") return false;

  let type: string;
  let body: string;

  if (m.body) {
    body = m.body;
    type = testEvent.parse(parseJsonText(m.body)).type;
  } else if (m.eventId) {
    const built = await buildEventBody(env, m.eventId);

    if (!built) return false;
    ({ type, body } = built);
  } else {
    return false;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await sign(hook.secret, m.messageId, timestamp, body);
  const started = Date.now();
  let statusCode: number | null = null;
  let excerpt: string | null = null;
  let error: string | null = null;

  try {
    const res = await fetch(hook.endpoint, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "fullsend-webhooks/1",
        "svix-id": m.messageId,
        "svix-timestamp": String(timestamp),
        "svix-signature": signature,
        "webhook-id": m.messageId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signature,
      },
    });

    statusCode = res.status;
    excerpt = (await res.text()).slice(0, 1000);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const duration = Date.now() - started;

  await env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, webhook_id, message_id, event_id, event_type, attempt,
       status_code, duration_ms, request_body, response_excerpt, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      hook.id,
      m.messageId,
      m.eventId,
      type,
      attempt,
      statusCode,
      duration,
      body,
      excerpt,
      error,
      Date.now(),
    )
    .run();

  const failed = statusCode === null || statusCode < 200 || statusCode >= 300;

  // No delay is left, so the queue does not try this delivery again.
  if (failed && RETRY_DELAYS[attempt - 1] === undefined) {
    await logSystemEvent(env, {
      level: "warn",
      source: "hooks",
      message: "A webhook delivery failed after the last retry.",
      detail: {
        webhookId: hook.id,
        eventType: type,
        attempts: attempt,
        statusCode,
      },
    });
  }

  return failed;
}
