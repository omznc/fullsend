import type { AttachmentMeta, EmailStatus } from "../db/schema";
import type { Env, SendMessage } from "../env";
import { eventInsert, fanout, type NewEvent } from "../events/record";
import type { ApiKeyRow } from "../keys/service";
import { domainOf, normalize } from "../lib/address";
import { ApiError, validation } from "../lib/errors";
import type { JsonValue } from "../lib/json";
import { emailSize, type ValidEmail, validateEmail } from "./validate";

export interface SendContext {
  // The value for the api_key_id column.
  apiKeyId: string;
  // The key, when the request came with one. Its domain scope applies.
  key?: ApiKeyRow | null;
}

// The object that fullsend keeps in R2 for each email.
export interface StoredBody {
  html: string | null;
  text: string | null;
  attachments: ValidEmail["attachments"];
}

interface Prepared {
  id: string;
  email: ValidEmail;
  domainId: string;
  kept: { to: string[]; cc: string[]; bcc: string[] };
  suppressed: string[];
  status: EmailStatus;
}

interface DomainInfo {
  id: string;
  name: string;
  status: string;
}

async function loadDomains(
  env: Env,
  names: string[],
): Promise<Map<string, DomainInfo>> {
  const unique = [...new Set(names)];
  const map = new Map<string, DomainInfo>();

  if (!unique.length) return map;

  const { results } = await env.DB.prepare(
    `SELECT id, name, status FROM domains WHERE name IN (${unique.map(() => "?").join(",")})`,
  )
    .bind(...unique)
    .all<DomainInfo>();

  for (const d of results) map.set(d.name, d);

  return map;
}

async function loadSuppressed(
  env: Env,
  addresses: string[],
): Promise<Set<string>> {
  const unique = [...new Set(addresses)];
  const out = new Set<string>();

  // D1 allows 100 bound parameters in one statement.
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90);

    const { results } = await env.DB.prepare(
      `SELECT address FROM suppressions WHERE address IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<{ address: string }>();

    for (const r of results) out.add(r.address);
  }

  return out;
}

function checkDomain(
  email: ValidEmail,
  domains: Map<string, DomainInfo>,
  ctx: SendContext,
): DomainInfo {
  const name = domainOf(email.fromAddress.email);
  const domain = domains.get(name);

  if (!domain || domain.status !== "verified") {
    throw new ApiError(
      403,
      "validation_error",
      `The ${name} domain is not verified. Please, add and verify your domain.`,
    );
  }

  if (ctx.key?.domainId && ctx.key.domainId !== domain.id) {
    throw new ApiError(
      403,
      "validation_error",
      `This API key cannot send from ${name}.`,
    );
  }

  return domain;
}

function prepare(
  email: ValidEmail,
  domains: Map<string, DomainInfo>,
  blocked: Set<string>,
  ctx: SendContext,
): Prepared {
  const domain = checkDomain(email, domains, ctx);
  const suppressed: string[] = [];

  const keep = (list: string[]) =>
    list.filter((a) => {
      if (!blocked.has(normalize(a))) return true;
      suppressed.push(a);

      return false;
    });

  const kept = { to: keep(email.to), cc: keep(email.cc), bcc: keep(email.bcc) };
  const none = !kept.to.length && !kept.cc.length && !kept.bcc.length;

  return {
    id: crypto.randomUUID(),
    email,
    domainId: domain.id,
    kept,
    suppressed,
    status: none ? "suppressed" : email.scheduledAt ? "scheduled" : "queued",
  };
}

export const bodyKey = (id: string) => `emails/${id}.json`;

async function commit(
  env: Env,
  items: Prepared[],
  ctx: SendContext,
): Promise<void> {
  const now = Date.now();
  const puts: Promise<R2Object | null>[] = [];

  for (const p of items) {
    if (p.status === "suppressed") continue;

    const body: StoredBody = {
      html: p.email.html,
      text: p.email.text,
      attachments: p.email.attachments,
    };

    puts.push(
      env.BODIES.put(bodyKey(p.id), JSON.stringify(body), {
        httpMetadata: { contentType: "application/json" },
      }),
    );
  }

  await Promise.all(puts);

  const stmts: D1PreparedStatement[] = [];
  const eventIds = new Map<EmailStatus, string[]>();

  for (const p of items) {
    const e = p.email;

    const attachments: AttachmentMeta[] = e.attachments.map((a) => {
      const meta: AttachmentMeta = {
        filename: a.filename,
        content_type: a.content_type,
        size: a.size,
      };

      if (a.content_id) meta.content_id = a.content_id;

      return meta;
    });

    const error =
      p.status === "suppressed"
        ? "Every recipient is on the suppression list."
        : null;

    stmts.push(
      env.DB.prepare(
        `INSERT INTO emails (id, api_key_id, domain_id, "from", "to", cc, bcc, reply_to, subject, tags, headers,
           attachments, suppressed, status, last_event, last_event_at, error, scheduled_at, body_key, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        p.id,
        ctx.apiKeyId,
        p.domainId,
        e.from,
        JSON.stringify(e.to),
        e.cc.length ? JSON.stringify(e.cc) : null,
        e.bcc.length ? JSON.stringify(e.bcc) : null,
        e.replyTo.length ? JSON.stringify(e.replyTo) : null,
        e.subject,
        e.tags ? JSON.stringify(e.tags) : null,
        e.headers ? JSON.stringify(e.headers) : null,
        attachments.length ? JSON.stringify(attachments) : null,
        p.suppressed.length ? JSON.stringify(p.suppressed) : null,
        p.status,
        p.status,
        now,
        error,
        e.scheduledAt,
        p.status === "suppressed" ? null : bodyKey(p.id),
        emailSize(e),
        now,
      ),
    );

    const ev: NewEvent = {
      type: p.status,
      at: now,
      data: p.suppressed.length ? { suppressed: p.suppressed } : null,
    };

    const eventId = crypto.randomUUID();
    stmts.push(eventInsert(env, p.id, ev, eventId));
    eventIds.set(p.status, [...(eventIds.get(p.status) ?? []), eventId]);
  }

  await env.DB.batch(stmts);

  const toSend = items.filter((p) => p.status === "queued");

  const messages: MessageSendRequest<SendMessage>[] = toSend.map((p) => ({
    body: { emailId: p.id },
  }));

  try {
    for (let i = 0; i < messages.length; i += 100) {
      await env.SEND_QUEUE.sendBatch(messages.slice(i, i + 100));
    }
  } catch (err) {
    // The rows exist but no message is on the queue. Mark them failed, so
    // the client can retry with a new request.
    await env.DB.batch(
      toSend.map((p) =>
        env.DB.prepare(
          "UPDATE emails SET status = 'failed', last_event = 'failed', error = ? WHERE id = ?",
        ).bind("fullsend could not put the email on the send queue.", p.id),
      ),
    );
    throw err;
  }

  // The emails are on the queue now. An error here must not fail the
  // request: a client retry with the same Idempotency-Key would send the
  // emails again.
  const results = await Promise.allSettled(
    [...eventIds].map(([type, ids]) => fanout(env, type, ids)),
  );

  for (const r of results) {
    if (r.status === "rejected") console.error("fanout failed", r.reason);
  }
}

export async function createEmail(
  env: Env,
  body: JsonValue,
  ctx: SendContext,
): Promise<{ id: string }> {
  const email = await validateEmail(body);
  const domains = await loadDomains(env, [domainOf(email.fromAddress.email)]);

  const blocked = await loadSuppressed(
    env,
    [...email.to, ...email.cc, ...email.bcc].map(normalize),
  );

  const prepared = prepare(email, domains, blocked, ctx);
  await commit(env, [prepared], ctx);

  return { id: prepared.id };
}

export interface BatchResult {
  data: { id: string }[];
  errors?: { index: number; message: string }[];
}

export async function createBatch(
  env: Env,
  body: JsonValue,
  ctx: SendContext,
  mode: "strict" | "permissive",
): Promise<BatchResult> {
  if (!Array.isArray(body))
    throw validation("The request body must be an array of emails.");

  if (body.length === 0)
    throw validation("The batch must have at least one email.");

  if (body.length > 100)
    throw validation("The batch must have 100 emails or less.");

  const errors: { index: number; message: string }[] = [];
  const valid: { index: number; email: ValidEmail }[] = [];

  for (const [index, item] of body.entries()) {
    try {
      valid.push({ index, email: await validateEmail(item, { batch: true }) });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;

      if (mode === "strict") {
        throw new ApiError(
          err.statusCode,
          err.errorName,
          `emails[${index}]: ${err.message}`,
        );
      }

      errors.push({ index, message: err.message });
    }
  }

  const domains = await loadDomains(
    env,
    valid.map((v) => domainOf(v.email.fromAddress.email)),
  );

  const blocked = await loadSuppressed(
    env,
    valid
      .flatMap((v) => [...v.email.to, ...v.email.cc, ...v.email.bcc])
      .map(normalize),
  );

  const prepared: Prepared[] = [];

  for (const v of valid) {
    try {
      prepared.push(prepare(v.email, domains, blocked, ctx));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;

      if (mode === "strict") {
        throw new ApiError(
          err.statusCode,
          err.errorName,
          `emails[${v.index}]: ${err.message}`,
        );
      }

      errors.push({ index: v.index, message: err.message });
    }
  }

  if (prepared.length) await commit(env, prepared, ctx);

  const result: BatchResult = { data: prepared.map((p) => ({ id: p.id })) };

  if (mode === "permissive") {
    result.errors = errors.toSorted((a, b) => a.index - b.index);
  }

  return result;
}
