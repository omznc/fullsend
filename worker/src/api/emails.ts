import { Hono } from "hono";
import { ApiError } from "../lib/errors";
import { asRecord, parseJson, readJson } from "../lib/http";
import { parsePage } from "../lib/page";
import {
  checkDownload,
  getAttachment,
  listAttachments,
  readAttachment,
} from "../send/attachments";
import { createBatch, createEmail } from "../send/create";
import { withIdempotency } from "../send/idempotency";
import {
  cancelEmail,
  emailJson,
  emailListJson,
  getBody,
  getEmail,
  listEmails,
  reschedule,
} from "../send/manage";
import { emailMetrics } from "../send/metrics";
import { apiKeyAuth, type ApiVars } from "./auth";

export const emailsApi = new Hono<ApiVars>();

emailsApi.post("/batch", apiKeyAuth({ sendOnly: true }), async (c) => {
  const key = c.get("apiKey");
  const raw = await c.req.text();

  const mode =
    c.req.header("x-batch-validation") === "permissive"
      ? "permissive"
      : "strict";

  const result = await withIdempotency(
    c.env,
    key.id,
    c.req.header("Idempotency-Key"),
    `batch:${mode}:${raw}`,
    async () => {
      const body = parseJson(raw);

      return createBatch(c.env, body, { apiKeyId: key.id, key }, mode);
    },
  );

  return c.json(result);
});

emailsApi.post("/", apiKeyAuth({ sendOnly: true }), async (c) => {
  const key = c.get("apiKey");
  const raw = await c.req.text();

  const result = await withIdempotency(
    c.env,
    key.id,
    c.req.header("Idempotency-Key"),
    `email:${raw}`,
    async () => {
      const body = parseJson(raw);

      return createEmail(c.env, body, { apiKeyId: key.id, key });
    },
  );

  return c.json(result);
});

emailsApi.get("/", apiKeyAuth(), async (c) => {
  const page = parsePage(c.req.query());
  const { emails, has_more } = await listEmails(c.env, page);

  return c.json({ object: "list", has_more, data: emails.map(emailListJson) });
});

emailsApi.get("/metrics", apiKeyAuth(), async (c) =>
  c.json(await emailMetrics(c.env, c.req.queries())),
);

emailsApi.get("/:id/attachments", apiKeyAuth(), async (c) => {
  const { data, has_more } = await listAttachments(
    c.env,
    new URL(c.req.url).origin,
    c.req.param("id"),
    parsePage(c.req.query()),
  );

  return c.json({ object: "list", has_more, data });
});

emailsApi.get("/:id/attachments/:attachmentId", apiKeyAuth(), async (c) => {
  const attachment = await getAttachment(
    c.env,
    new URL(c.req.url).origin,
    c.req.param("id"),
    c.req.param("attachmentId"),
  );

  return c.json({ object: "attachment", ...attachment });
});

// The signed link of an attachment. It has no API key: the signature and
// the expiry in the query are the proof.
emailsApi.get("/:id/attachments/:attachmentId/download", async (c) => {
  const id = c.req.param("id");
  const index = c.req.param("attachmentId");
  const { expires, sig } = c.req.query();

  if (
    !/^\d{1,4}$/.test(index) ||
    !(await checkDownload(c.env, id, Number(index), expires, sig))
  ) {
    throw new ApiError(
      403,
      "invalid_access",
      "The download link is not valid, or it has expired.",
    );
  }

  const file = await readAttachment(c.env, id, Number(index));
  const ascii = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");

  return new Response(file.bytes, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "Content-Security-Policy": "sandbox",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

emailsApi.get("/:id", apiKeyAuth(), async (c) => {
  const email = await getEmail(c.env, c.req.param("id"));

  return c.json(emailJson(email, await getBody(c.env, email)));
});

emailsApi.patch("/:id", apiKeyAuth(), async (c) => {
  const body = asRecord(await readJson(c));
  const email = await reschedule(c.env, c.req.param("id"), body.scheduled_at);

  return c.json({ object: "email", id: email.id });
});

emailsApi.post("/:id/cancel", apiKeyAuth(), async (c) => {
  const id = c.req.param("id");
  await cancelEmail(c.env, id);

  return c.json({ object: "email", id });
});
