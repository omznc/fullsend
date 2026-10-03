import { Hono } from "hono";
import { asRecord, readJson } from "../lib/http";
import { parsePage } from "../lib/page";
import { iso } from "../lib/time";
import {
  getEvent,
  listAttempts,
  listEvents,
  replayEvent,
} from "../webhooks/events";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooksPage,
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
  const { rows, has_more } = await listWebhooksPage(
    c.env,
    parsePage(c.req.query()),
  );

  return c.json({
    object: "list",
    has_more,
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

webhooksApi.get("/:id/events", async (c) => {
  const { data, has_more } = await listEvents(
    c.env,
    c.req.param("id"),
    parsePage(c.req.query()),
  );

  return c.json({ object: "list", has_more, data });
});

webhooksApi.get("/:id/events/:eventId", async (c) => {
  const event = await getEvent(
    c.env,
    c.req.param("id"),
    c.req.param("eventId"),
  );

  return c.json({ object: "webhook_event", ...event });
});

webhooksApi.get("/:id/events/:eventId/attempts", async (c) => {
  const { data, has_more } = await listAttempts(
    c.env,
    c.req.param("id"),
    c.req.param("eventId"),
    parsePage(c.req.query()),
  );

  return c.json({ object: "list", has_more, data });
});

webhooksApi.post("/:id/events/:eventId/replay", async (c) => {
  const eventId = c.req.param("eventId");
  await replayEvent(c.env, c.req.param("id"), eventId);

  return c.json({ object: "webhook_event", id: eventId });
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
