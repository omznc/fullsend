import { Hono } from "hono";
import { asRecord, parseJson, readJson } from "../lib/http";
import { createBatch, createEmail } from "../send/create";
import { withIdempotency } from "../send/idempotency";
import {
  cancelEmail,
  emailJson,
  emailListJson,
  getBody,
  getEmail,
  listEmails,
  parsePage,
  reschedule,
} from "../send/manage";
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
