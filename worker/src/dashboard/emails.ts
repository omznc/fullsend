import { Hono } from "hono";
import type { EmailRow } from "../events/record";
import { notFound, validation } from "../lib/errors";
import { asRecord, readJson } from "../lib/http";
import { iso, isoOrNull } from "../lib/time";
import { createEmail } from "../send/create";
import {
  cancelEmail,
  getBody,
  getEmail,
  listEmails,
  parsePage,
  reschedule,
} from "../send/manage";
import type { DashVars } from "./auth";

export const emailRoutes = new Hono<DashVars>();

async function keyNames(
  env: DashVars["Bindings"],
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => !id.includes(":"));
  const map = new Map<string, string>();

  if (!unique.length) return map;

  const { results } = await env.DB.prepare(
    `SELECT id, name FROM api_keys WHERE id IN (${unique.map(() => "?").join(",")})`,
  )
    .bind(...unique)
    .all<{ id: string; name: string }>();

  for (const r of results) map.set(r.id, r.name);

  return map;
}

// The API key that sent an email, as the dashboard shows it.
interface KeyLabel {
  id: string;
  name: string;
}

// "rpc:<caller>" and "dashboard:<identity>" are shown as they are.
function keyLabel(id: string, names: Map<string, string>): KeyLabel {
  return { id, name: names.get(id) ?? (id.includes(":") ? id : "deleted key") };
}

export function dashEmail(e: EmailRow, names: Map<string, string>) {
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    cc: e.cc,
    bcc: e.bcc,
    reply_to: e.replyTo,
    subject: e.subject,
    status: e.status,
    last_event: e.lastEvent,
    last_event_at: iso(e.lastEventAt),
    error: e.error,
    tags: e.tags ?? [],
    api_key: keyLabel(e.apiKeyId, names),
    domain_id: e.domainId,
    scheduled_at: isoOrNull(e.scheduledAt),
    sent_at: isoOrNull(e.sentAt),
    created_at: iso(e.createdAt),
    message_id: e.cfMessageId,
    size: e.size,
  };
}

const date = (v: string | undefined) => {
  if (!v) return undefined;
  const t = Date.parse(v);

  if (Number.isNaN(t)) throw validation(`Invalid date: ${v}`);

  return t;
};

emailRoutes.get("/", async (c) => {
  const q = c.req.query();

  const status =
    q.tab === "scheduled"
      ? ["scheduled"]
      : q.status
        ? q.status.split(",").filter(Boolean)
        : undefined;

  const { emails, has_more } = await listEmails(c.env, parsePage(q), {
    status,
    domainId: q.domain || undefined,
    apiKeyId: q.api_key || undefined,
    tag: q.tag || undefined,
    since: date(q.since),
    until: date(q.until),
    q: q.q?.trim() || undefined,
  });

  const names = await keyNames(
    c.env,
    emails.map((e) => e.apiKeyId),
  );

  return c.json({
    object: "list",
    has_more,
    data: emails.map((e) => dashEmail(e, names)),
  });
});

// Sends an email with the dashboard session (playground, test email).
emailRoutes.post("/", async (c) => {
  const body = await readJson(c);

  const result = await createEmail(c.env, body, {
    apiKeyId: `dashboard:${c.get("identity")}`,
  });

  return c.json(result);
});

emailRoutes.get("/:id", async (c) => {
  const email = await getEmail(c.env, c.req.param("id"));

  const [names, events] = await Promise.all([
    keyNames(c.env, [email.apiKeyId]),
    c.env.DB.prepare(
      "SELECT * FROM email_events WHERE email_id = ? ORDER BY created_at ASC",
    )
      .bind(email.id)
      .all<{
        id: string;
        recipient: string | null;
        type: string;
        data: string | null;
        bot: string | null;
        created_at: number;
      }>(),
  ]);

  return c.json({
    ...dashEmail(email, names),
    headers: email.headers ?? {},
    attachments: email.attachments ?? [],
    suppressed: email.suppressed ?? [],
    body_available: Boolean(email.bodyKey),
    events: events.results.map((ev) => ({
      id: ev.id,
      type: ev.type,
      recipient: ev.recipient,
      bot: ev.bot,
      data: ev.data ? JSON.parse(ev.data) : null,
      created_at: iso(ev.created_at),
    })),
  });
});

emailRoutes.get("/:id/body", async (c) => {
  const email = await getEmail(c.env, c.req.param("id"));
  const body = await getBody(c.env, email);

  const headers = new Map([
    ["From", email.from],
    ["To", email.to.join(", ")],
  ]);

  if (email.cc?.length) headers.set("Cc", email.cc.join(", "));

  if (email.replyTo?.length) headers.set("Reply-To", email.replyTo.join(", "));
  headers.set("Subject", email.subject);

  for (const [name, value] of Object.entries(email.headers ?? {})) {
    headers.set(name, value);
  }

  return c.json({
    html: body?.html ?? null,
    text: body?.text ?? null,
    headers: Object.fromEntries(headers),
  });
});

emailRoutes.get("/:id/attachments/:index", async (c) => {
  const email = await getEmail(c.env, c.req.param("id"));
  const body = await getBody(c.env, email);
  const a = body?.attachments[Number(c.req.param("index"))];

  if (!a) throw notFound("Attachment");
  const bytes = Uint8Array.from(atob(a.content), (ch) => ch.charCodeAt(0));

  return new Response(bytes, {
    headers: {
      "Content-Type": a.content_type,
      "Content-Disposition": `attachment; filename="${a.filename.replace(/"/g, "")}"`,
    },
  });
});

emailRoutes.patch("/:id", async (c) => {
  const body = asRecord(await readJson(c));
  const email = await reschedule(c.env, c.req.param("id"), body.scheduled_at);

  return c.json({ id: email.id, scheduled_at: isoOrNull(email.scheduledAt) });
});

emailRoutes.post("/:id/cancel", async (c) => {
  await cancelEmail(c.env, c.req.param("id"));

  return c.json({ ok: true });
});

// Sends a copy of the email as a new email.
emailRoutes.post("/:id/resend", async (c) => {
  const email = await getEmail(c.env, c.req.param("id"));
  const body = await getBody(c.env, email);

  if (!body) throw validation("The body of this email is no longer stored.");

  const result = await createEmail(
    c.env,
    {
      from: email.from,
      to: email.to,
      cc: email.cc ?? undefined,
      bcc: email.bcc ?? undefined,
      reply_to: email.replyTo ?? undefined,
      subject: email.subject,
      html: body.html ?? undefined,
      text: body.text ?? undefined,
      headers: email.headers ?? undefined,
      tags: email.tags ?? undefined,
      attachments: body.attachments.length ? body.attachments : undefined,
    },
    { apiKeyId: `dashboard:${c.get("identity")}` },
  );

  return c.json(result);
});
