import { z } from "zod";
import type { EmailStatus } from "../db/schema";
import type { Env, SendMessage } from "../env";
import { type EmailRow, type EventData, recordEvent } from "../events/record";
import { parseAddress } from "../lib/address";
import { parseJsonText } from "../lib/json";
import { sessionSecret } from "../lib/secrets";
import { getSettings, trackingOrigin } from "../lib/settings";
import { errorText, logSystemEvent } from "../lib/system-events";
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
    const held: Held = { token: null };

    try {
      await sendOne(env, msg, held);
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "send.error",
          emailId: msg.body.emailId,
          attempts: msg.attempts,
          error: errorText(err),
        }),
      );
      await giveUp(env, msg, err, held).catch((e) =>
        console.error(
          JSON.stringify({
            evt: "send.give_up_failed",
            emailId: msg.body.emailId,
            error: errorText(e),
          }),
        ),
      );
    }
  }
}

// The claim token of the consumer for the message that it handles. It is
// null until the consumer gets the claim.
interface Held {
  token: string | null;
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
  held: Held,
): Promise<void> {
  if (held.token) await release(env, msg.body.emailId, held.token);

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

// Ends the claim of this consumer, and the send mark with it. A claim that
// a different consumer holds now has a different token and stays.
async function release(env: Env, id: string, token: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE emails SET claimed_at = NULL, claim_token = NULL, send_started_at = NULL WHERE id = ? AND claim_token = ?",
  )
    .bind(id, token)
    .run();
}

// Takes the email for this consumer and returns the claim token. Returns
// null when a different consumer holds it, or when the email is not
// pending now. An expired claim is taken only when its consumer did not
// start the send: a consumer that stopped in EMAIL.send can have sent the
// email, and the sweep handles that email.
async function claim(env: Env, id: string): Promise<string | null> {
  const now = Date.now();
  const token = crypto.randomUUID();

  const row = await env.DB.prepare(
    `UPDATE emails SET claimed_at = ?1, claim_token = ?4, send_started_at = NULL
     WHERE id = ?2 AND status IN ('queued', 'scheduled') AND cf_message_id IS NULL
       AND (claimed_at IS NULL OR (claimed_at < ?3 AND send_started_at IS NULL))
     RETURNING id`,
  )
    .bind(now, id, now - CLAIM_TTL, token)
    .first();

  return row === null ? null : token;
}

// Writes the send mark before EMAIL.send. Returns false when the claim is
// not the claim of this consumer now, or when the email is not pending
// now (the owner canceled it). Then the consumer must not send.
async function markSending(
  env: Env,
  id: string,
  token: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "UPDATE emails SET send_started_at = ? WHERE id = ? AND claim_token = ? AND status IN ('queued', 'scheduled') RETURNING id",
  )
    .bind(Date.now(), id, token)
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
  claim_token: string | null;
  send_started_at: number | null;
  cf_message_id: string | null;
  body_key: string | null;
  size: number;
  sweep_count: number;
  ignored_at: number | null;
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

// The list and JSON columns of an email row.
function parsedColumns(r: EmailDbRow) {
  return {
    to: jsonColumn(r.to, addressColumn) ?? [],
    cc: jsonColumn(r.cc, addressColumn),
    bcc: jsonColumn(r.bcc, addressColumn),
    replyTo: jsonColumn(r.reply_to, addressColumn),
    tags: jsonColumn(r.tags, tagsColumn),
    headers: jsonColumn(r.headers, headersColumn),
    attachments: jsonColumn(r.attachments, attachmentsColumn),
    suppressed: jsonColumn(r.suppressed, addressColumn),
  };
}

export function rowToEmail(r: EmailDbRow): EmailRow {
  return {
    ...parsedColumns(r),
    id: r.id,
    apiKeyId: r.api_key_id,
    domainId: r.domain_id ?? null,
    from: r.from,
    subject: r.subject,
    status: r.status,
    lastEvent: r.last_event,
    lastEventAt: r.last_event_at,
    error: r.error ?? null,
    scheduledAt: r.scheduled_at ?? null,
    dispatchedAt: r.dispatched_at ?? null,
    claimedAt: r.claimed_at ?? null,
    claimToken: r.claim_token,
    sendStartedAt: r.send_started_at,
    cfMessageId: r.cf_message_id ?? null,
    bodyKey: r.body_key ?? null,
    size: r.size,
    sweepCount: r.sweep_count,
    ignoredAt: r.ignored_at ?? null,
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

// Acks a message that needs no send: the email is gone, sent already, not
// pending, or moved to a later time. Returns true when it acked.
async function acked(
  env: Env,
  msg: Message<SendMessage>,
  email: EmailRow | null,
): Promise<boolean> {
  if (!email) {
    msg.ack();

    return true;
  }

  // Cloudflare accepted the email, but the sent event is not done. This
  // happens after a failure between the send and the event.
  if (email.cfMessageId) {
    await recordSent(env, email, email.cfMessageId, email.sentAt ?? Date.now());
    msg.ack();

    return true;
  }

  // The owner moved a scheduled email after the cron put it on the queue.
  // The cron puts it on the queue again at the new time.
  const moved =
    email.status === "scheduled" &&
    (email.scheduledAt ?? 0) > Date.now() + 30_000;

  if (!isPending(email) || moved) {
    msg.ack();

    return true;
  }

  return false;
}

async function withTracking(
  env: Env,
  email: EmailRow,
  html: string | null | undefined,
): Promise<string | null | undefined> {
  if (!html || !email.domainId) return html;

  const [domain, settings] = await Promise.all([
    env.DB.prepare(
      "SELECT open_tracking, click_tracking FROM domains WHERE id = ?",
    )
      .bind(email.domainId)
      .first<{ open_tracking: number; click_tracking: number }>(),
    getSettings(env),
  ]);

  const origin = trackingOrigin(settings);

  if (!domain || !origin || !(domain.open_tracking || domain.click_tracking)) {
    return html;
  }

  return addTracking(html, {
    origin,
    emailId: email.id,
    open: Boolean(domain.open_tracking),
    clickSecret: domain.click_tracking ? await sessionSecret(env) : null,
  });
}

function attachmentsOf(body: StoredBody): EmailAttachment[] {
  return body.attachments.map((a) =>
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

// Cloudflare needs at least one of to, cc and bcc. `to` can be empty when
// fullsend dropped suppressed recipients.
function destinationOf(to: string[], cc: string[], bcc: string[]) {
  if (to.length) return { to: to.map(asAddress) };

  return cc.length ? { cc: cc.map(asAddress) } : { bcc: bcc.map(asAddress) };
}

// Builds the message for the send_email binding from the stored body.
async function buildMessage(
  env: Env,
  email: EmailRow,
  body: StoredBody,
): Promise<EmailMessageBuilder> {
  const skip = new Set((email.suppressed ?? []).map((a) => a.toLowerCase()));

  const keep = (list: string[] | null) =>
    (list ?? []).filter((a) => !skip.has(a.toLowerCase()));

  const to = keep(email.to);
  const cc = keep(email.cc);
  const bcc = keep(email.bcc);
  const html = await withTracking(env, email, body.html);

  const message: EmailMessageBuilder = {
    from: asAddress(email.from),
    subject: email.subject,
    ...destinationOf(to, cc, bcc),
  };

  if (cc.length) message.cc = cc.map(asAddress);

  if (bcc.length) message.bcc = bcc.map(asAddress);

  // Cloudflare takes one reply-to address.
  if (email.replyTo?.length) message.replyTo = asAddress(email.replyTo[0]!);

  if (html) message.html = html;

  if (body.text) message.text = body.text;

  if (email.headers) message.headers = email.headers;

  if (body.attachments.length) message.attachments = attachmentsOf(body);

  return message;
}

async function sendOne(
  env: Env,
  msg: Message<SendMessage>,
  held: Held,
): Promise<void> {
  const email = await loadEmail(env, msg.body.emailId);

  if (await acked(env, msg, email)) return;

  // `acked` returns true for a missing email, so the email is here.
  const pending = email!;
  const token = await claim(env, pending.id);

  // A second copy of this message holds the email. Look again later: the
  // copy sends the email, or its claim expires.
  if (!token) {
    // The queue must not drop the message at max_retries. Ack it. The
    // cron sweep (src/cron.ts) handles an email that stays pending.
    if (msg.attempts >= MAX_ATTEMPTS) return msg.ack();

    return msg.retry({ delaySeconds: CLAIM_TTL / 1000 });
  }

  held.token = token;

  const stored = pending.bodyKey ? await env.BODIES.get(pending.bodyKey) : null;

  if (!stored) {
    await fail(env, pending, "The email body is missing from storage.");
    await release(env, pending.id, token);

    return msg.ack();
  }

  const message = await buildMessage(env, pending, await stored.json());

  // The mark comes before the send. A copy of this message that finds the
  // mark after the claim expires does not send the email again.
  if (!(await markSending(env, pending.id, token))) {
    await release(env, pending.id, token);

    return msg.ack();
  }

  let messageId: string;

  try {
    ({ messageId } = await env.EMAIL.send(message));
  } catch (err) {
    const code = hasCode(err) ? err.code : "";
    const reason = err instanceof Error ? err.message : String(err);

    return onSendError(env, msg, pending, token, { code, reason });
  }

  await afterSend(env, msg, pending, messageId);
}

// Handles an error of EMAIL.send. The send did not happen, so the claim
// ends and the message can retry.
async function onSendError(
  env: Env,
  msg: Message<SendMessage>,
  email: EmailRow,
  token: string,
  { code, reason }: { code: string; reason: string },
): Promise<void> {
  await release(env, email.id, token);

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

  // The reason can name a recipient, so the log has the code only.
  console.warn(
    JSON.stringify({
      evt: "send.retry",
      emailId: email.id,
      code,
      attempts: msg.attempts,
    }),
  );

  return msg.retry({ delaySeconds: backoff(msg.attempts) });
}

// Store the Cloudflare message id first. With it, a retry does not send
// the email again. Keep the code between `send` and this write short.
async function afterSend(
  env: Env,
  msg: Message<SendMessage>,
  email: EmailRow,
  messageId: string,
): Promise<void> {
  const now = Date.now();

  if (!(await storeMessageId(env, email.id, messageId, now))) {
    // The email is sent, but D1 did not take the id. Keep the claim and
    // ack the message: a release or a retry can send the email again. The
    // cron sweep fails the email when the claim is old (case c).
    await logSystemEvent(env, {
      level: "error",
      source: "send",
      message:
        "The email was sent, but the Cloudflare message id was not stored.",
      detail: { emailId: email.id, cfMessageId: messageId },
    });

    return msg.ack();
  }

  await recordSent(env, email, messageId, now);
  msg.ack();
}

// Waits before each new try of the write that follows `send`, in
// milliseconds.
const STORE_RETRY_DELAYS = [50, 200, 800];

// Stores the Cloudflare message id and ends the claim. Tries again a few
// times, because a failure here can cause a second send. Returns false
// when each try failed.
async function storeMessageId(
  env: Env,
  id: string,
  messageId: string,
  at: number,
): Promise<boolean> {
  for (let i = 0; i <= STORE_RETRY_DELAYS.length; i++) {
    try {
      await env.DB.prepare(
        "UPDATE emails SET cf_message_id = ?, sent_at = ?, claimed_at = NULL, claim_token = NULL WHERE id = ?",
      )
        .bind(messageId, at, id)
        .run();

      return true;
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "send.store_failed",
          emailId: id,
          try: i + 1,
          error: errorText(err),
        }),
      );

      const delay = STORE_RETRY_DELAYS[i];

      if (delay !== undefined) await sleep(delay);
    }
  }

  return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
