import { z } from "zod";
import type { EmailStatus } from "../db/schema";
import type { Env, SendMessage } from "../env";
import { type EmailRow, type EventData, recordEvent } from "../events/record";
import { parseAddress } from "../lib/address";
import { parseJsonText } from "../lib/json";
import { sessionSecret } from "../lib/secrets";
import { getSettings, trackingOrigin } from "../lib/settings";
import { addTracking } from "../tracking/rewrite";
import type { StoredBody } from "./create";

// Cloudflare error codes that a retry cannot fix.
const PERMANENT = new Set([
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_VALIDATION_ERROR",
  "E_RECIPIENT_SUPPRESSED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_CONTENT_TOO_LARGE",
  "E_DELIVERY_FAILED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
]);

// The consumer marks the email failed on this attempt. It is lower than
// max_retries in wrangler.jsonc, so the queue never drops a message.
export const MAX_ATTEMPTS = 5;

// A claim older than this belongs to a consumer that died. A new copy of
// the message may take the email.
export const CLAIM_TTL = 2 * 60_000;

const asAddress = (input: string): string | EmailAddress => {
  const a = parseAddress(input);

  if (!a) return input;

  return a.name ? { name: a.name, email: a.email } : a.email;
};

export async function handleSendBatch(
  batch: MessageBatch<SendMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await sendOne(env, msg);
    } catch (err) {
      console.error("send consumer error", msg.body.emailId, err);
      await giveUp(env, msg, err).catch((e) =>
        console.error("send consumer give up", msg.body.emailId, e),
      );
    }
  }
}

// An error from the send_email binding carries a Cloudflare error code.
interface CodedError {
  code: string;
}

function hasCode(err: unknown): err is CodedError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof err.code === "string"
  );
}

const backoff = (attempts: number) => Math.min(600, 10 * 2 ** attempts);

// An error that sendOne did not handle, for example a D1 or R2 error.
// The email fails on the last attempt, so it does not stay queued.
async function giveUp(
  env: Env,
  msg: Message<SendMessage>,
  cause: unknown,
): Promise<void> {
  await release(env, msg.body.emailId);

  if (msg.attempts < MAX_ATTEMPTS) {
    return msg.retry({ delaySeconds: backoff(msg.attempts) });
  }

  const email = await loadEmail(env, msg.body.emailId);

  if (email && !email.cfMessageId && isPending(email)) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    await fail(env, email, `${reason} (after ${msg.attempts} attempts)`);
  }

  msg.ack();
}

const isPending = (email: EmailRow) =>
  email.status === "queued" || email.status === "scheduled";

async function release(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE emails SET claimed_at = NULL WHERE id = ?")
    .bind(id)
    .run();
}

// Takes the email for this consumer. Returns false when a different
// consumer holds it, or when the email is not pending now.
async function claim(env: Env, id: string): Promise<boolean> {
  const now = Date.now();

  const row = await env.DB.prepare(
    `UPDATE emails SET claimed_at = ?1
     WHERE id = ?2 AND status IN ('queued', 'scheduled') AND cf_message_id IS NULL
       AND (claimed_at IS NULL OR claimed_at < ?3)
     RETURNING id`,
  )
    .bind(now, id, now - CLAIM_TTL)
    .first();

  return row !== null;
}

// Records the sent event. The event id comes from the email id, so a
// retry after a partial failure does not make a second event.
function recordSent(env: Env, email: EmailRow, messageId: string, at: number) {
  return recordEvent(env, email.id, {
    type: "sent",
    at,
    cfEventId: `sent:${email.id}`,
    data: { message_id: messageId },
  });
}

async function loadEmail(env: Env, id: string): Promise<EmailRow | null> {
  const row = await env.DB.prepare("SELECT * FROM emails WHERE id = ?")
    .bind(id)
    .first<EmailDbRow>();

  return row ? rowToEmail(row) : null;
}

// A row of the emails table, as D1 returns it for `SELECT *`.
export interface EmailDbRow {
  id: string;
  api_key_id: string;
  domain_id: string | null;
  from: string;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  subject: string;
  tags: string | null;
  headers: string | null;
  attachments: string | null;
  suppressed: string | null;
  status: EmailStatus;
  last_event: EmailStatus;
  last_event_at: number;
  error: string | null;
  scheduled_at: number | null;
  dispatched_at: number | null;
  claimed_at: number | null;
  cf_message_id: string | null;
  body_key: string | null;
  size: number;
  sweep_count: number;
  created_at: number;
  sent_at: number | null;
}

const addressColumn = z.array(z.string());

// Reads the `to` column (or a different address list column) of an email.
export function parseAddressColumn(text: string): string[] {
  return addressColumn.parse(parseJsonText(text));
}

const tagsColumn = z.array(z.object({ name: z.string(), value: z.string() }));

const headersColumn = z.record(z.string(), z.string());

const attachmentsColumn = z.array(
  z.object({
    filename: z.string(),
    content_type: z.string(),
    size: z.number(),
    content_id: z.string().optional(),
  }),
);

// Parses a JSON column. A NULL column gives null.
function jsonColumn<T>(text: string | null, schema: z.ZodType<T>): T | null {
  return text === null ? null : schema.parse(parseJsonText(text));
}

export function rowToEmail(r: EmailDbRow): EmailRow {
  return {
    id: r.id,
    apiKeyId: r.api_key_id,
    domainId: r.domain_id ?? null,
    from: r.from,
    to: jsonColumn(r.to, addressColumn) ?? [],
    cc: jsonColumn(r.cc, addressColumn),
    bcc: jsonColumn(r.bcc, addressColumn),
    replyTo: jsonColumn(r.reply_to, addressColumn),
    subject: r.subject,
    tags: jsonColumn(r.tags, tagsColumn),
    headers: jsonColumn(r.headers, headersColumn),
    attachments: jsonColumn(r.attachments, attachmentsColumn),
    suppressed: jsonColumn(r.suppressed, addressColumn),
    status: r.status,
    lastEvent: r.last_event,
    lastEventAt: r.last_event_at,
    error: r.error ?? null,
    scheduledAt: r.scheduled_at ?? null,
    dispatchedAt: r.dispatched_at ?? null,
    claimedAt: r.claimed_at ?? null,
    cfMessageId: r.cf_message_id ?? null,
    bodyKey: r.body_key ?? null,
    size: r.size,
    sweepCount: r.sweep_count,
    createdAt: r.created_at,
    sentAt: r.sent_at ?? null,
  };
}

// Marks the email failed: the failed event, the error text and the
// email.failed webhooks.
export async function fail(
  env: Env,
  email: EmailRow,
  reason: string,
  code?: string,
): Promise<void> {
  const data: EventData = { reason };

  if (code) data.code = code;

  await recordEvent(env, email.id, { type: "failed", data, error: reason });
}

async function sendOne(env: Env, msg: Message<SendMessage>): Promise<void> {
  const email = await loadEmail(env, msg.body.emailId);

  if (!email) return msg.ack();

  // Cloudflare accepted the email, but the sent event is not done. This
  // happens after a failure between the send and the event.
  if (email.cfMessageId) {
    await recordSent(env, email, email.cfMessageId, email.sentAt ?? Date.now());

    return msg.ack();
  }

  if (!isPending(email)) return msg.ack();

  // The owner moved a scheduled email after the cron put it on the queue.
  // The cron puts it on the queue again at the new time.
  if (
    email.status === "scheduled" &&
    (email.scheduledAt ?? 0) > Date.now() + 30_000
  ) {
    return msg.ack();
  }

  // A second copy of this message holds the email. Look again later: the
  // copy sends the email, or its claim expires.
  if (!(await claim(env, email.id))) {
    // The queue must not drop the message at max_retries. Ack it. The
    // cron sweep (src/cron.ts) handles an email that stays pending.
    if (msg.attempts >= MAX_ATTEMPTS) return msg.ack();

    return msg.retry({ delaySeconds: CLAIM_TTL / 1000 });
  }

  const stored = email.bodyKey ? await env.BODIES.get(email.bodyKey) : null;

  if (!stored) {
    await fail(env, email, "The email body is missing from storage.");
    await release(env, email.id);

    return msg.ack();
  }

  const body = await stored.json<StoredBody>();

  const skip = new Set((email.suppressed ?? []).map((a) => a.toLowerCase()));

  const keep = (list: string[] | null) =>
    (list ?? []).filter((a) => !skip.has(a.toLowerCase()));

  const to = keep(email.to);
  const cc = keep(email.cc);
  const bcc = keep(email.bcc);

  let html = body.html;

  if (html && email.domainId) {
    const [domain, settings] = await Promise.all([
      env.DB.prepare(
        "SELECT open_tracking, click_tracking FROM domains WHERE id = ?",
      )
        .bind(email.domainId)
        .first<{ open_tracking: number; click_tracking: number }>(),
      getSettings(env),
    ]);

    const origin = trackingOrigin(settings);

    if (domain && origin && (domain.open_tracking || domain.click_tracking)) {
      html = await addTracking(html, {
        origin,
        emailId: email.id,
        open: Boolean(domain.open_tracking),
        clickSecret: domain.click_tracking ? await sessionSecret(env) : null,
      });
    }
  }

  // Cloudflare needs at least one of to, cc and bcc. `to` can be empty
  // when fullsend dropped suppressed recipients.
  const destination = to.length
    ? { to: to.map(asAddress) }
    : cc.length
      ? { cc: cc.map(asAddress) }
      : { bcc: bcc.map(asAddress) };

  const message: EmailMessageBuilder = {
    from: asAddress(email.from),
    subject: email.subject,
    ...destination,
  };

  if (cc.length) message.cc = cc.map(asAddress);

  if (bcc.length) message.bcc = bcc.map(asAddress);

  // Cloudflare takes one reply-to address.
  if (email.replyTo?.length) message.replyTo = asAddress(email.replyTo[0]!);

  if (html) message.html = html;

  if (body.text) message.text = body.text;

  if (email.headers) message.headers = email.headers;

  if (body.attachments.length) {
    message.attachments = body.attachments.map((a) =>
      a.content_id
        ? {
            disposition: "inline" as const,
            contentId: a.content_id,
            filename: a.filename,
            type: a.content_type,
            content: a.content,
          }
        : {
            disposition: "attachment" as const,
            filename: a.filename,
            type: a.content_type,
            content: a.content,
          },
    );
  }

  let messageId: string;

  try {
    ({ messageId } = await env.EMAIL.send(message));
  } catch (err) {
    await release(env, email.id);
    const code = hasCode(err) ? err.code : "";
    const reason = err instanceof Error ? err.message : String(err);

    if (PERMANENT.has(code)) {
      await fail(env, email, reason, code);

      return msg.ack();
    }

    if (msg.attempts >= MAX_ATTEMPTS) {
      await fail(
        env,
        email,
        `${reason} (after ${msg.attempts} attempts)`,
        code || undefined,
      );

      return msg.ack();
    }

    console.warn("send retry", email.id, code, reason);

    return msg.retry({ delaySeconds: backoff(msg.attempts) });
  }

  // Store the Cloudflare message id first. With it, a retry does not send
  // the email again. A risk stays: if the Worker stops after `send`
  // returns and before this write, the id is lost. The claim then expires,
  // and a later copy of the message can send the email a second time. The
  // Email Sending binding has no idempotency key that closes this window.
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE emails SET cf_message_id = ?, sent_at = ?, claimed_at = NULL WHERE id = ?",
  )
    .bind(messageId, now, email.id)
    .run();
  await recordSent(env, email, messageId, now);
  msg.ack();
}
