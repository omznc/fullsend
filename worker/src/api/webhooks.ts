import { Hono } from "hono";
import { asRecord, readJson } from "../lib/http";
import { iso } from "../lib/time";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  rotateSecret,
  updateWebhook,
} from "../webhooks/service";
import { apiKeyAuth, type ApiVars } from "./auth";

export const webhooksApi = new Hono<ApiVars>();

webhooksApi.use(apiKeyAuth());

webhooksApi.post("/", async (c) => {
  const row = await createWebhook(c.env, asRecord(await readJson(c)));

  return c.json({ object: "webhook", id: row.id, signing_secret: row.secret });
});

webhooksApi.get("/", async (c) => {
  const rows = await listWebhooks(c.env);

  return c.json({
    object: "list",
    has_more: false,
    data: rows.map((w) => ({
      id: w.id,
      endpoint: w.endpoint,
      created_at: iso(w.createdAt),
      status: w.status,
      events: w.events,
    })),
  });
});

webhooksApi.get("/:id", async (c) => {
  const w = await getWebhook(c.env, c.req.param("id"));

  return c.json({
    object: "webhook",
    id: w.id,
    created_at: iso(w.createdAt),
    status: w.status,
    endpoint: w.endpoint,
    events: w.events,
    signing_secret: w.secret,
  });
});

webhooksApi.patch("/:id", async (c) => {
  const w = await updateWebhook(
    c.env,
    c.req.param("id"),
    asRecord(await readJson(c)),
  );

  return c.json({ object: "webhook", id: w.id });
});

webhooksApi.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await deleteWebhook(c.env, id);

  return c.json({ object: "webhook", id, deleted: true });
});

webhooksApi.post("/:id/signing-secret/rotate", async (c) => {
  const id = c.req.param("id");
  const secret = await rotateSecret(c.env, id);

  return c.json({ object: "webhook", id, signing_secret: secret });
});
