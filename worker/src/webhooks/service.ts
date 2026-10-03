import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import { webhooks } from "../db/schema";
import type { Env } from "../env";
import { newMessageId, WEBHOOK_EVENTS } from "../events/record";
import { notFound, validation } from "../lib/errors";
import { isString, type JsonObject, type JsonValue } from "../lib/json";
import { inPageOrder, type Page, pageQuery } from "../lib/page";
import { testBody } from "./payload";
import { newSecret } from "./sign";

export type WebhookRow = typeof webhooks.$inferSelect;

function checkEndpoint(value: JsonValue | undefined): string {
  if (!isString(value)) throw validation("Missing `endpoint` field.");
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw validation("The `endpoint` must be a URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw validation("The `endpoint` must be an http or https URL.");
  }

  return url.toString();
}

function checkEvents(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw validation("The `events` field must be a list of event types.");
  }

  const events = new Set<string>();

  for (const e of value) {
    if (!isString(e) || !WEBHOOK_EVENTS.includes(e)) {
      throw validation(
        `Unknown event \`${String(e)}\`. fullsend sends: ${WEBHOOK_EVENTS.join(", ")}.`,
      );
    }

    events.add(e);
  }

  return [...events];
}

export async function createWebhook(
  env: Env,
  input: JsonObject,
): Promise<WebhookRow> {
  const row: WebhookRow = {
    id: crypto.randomUUID(),
    endpoint: checkEndpoint(input.endpoint),
    events: checkEvents(input.events),
    secret: newSecret(),
    status: "enabled",
    createdAt: Date.now(),
  };

  await getDb(env).insert(webhooks).values(row);

  return row;
}

export function listWebhooks(env: Env): Promise<WebhookRow[]> {
  return getDb(env).select().from(webhooks).orderBy(desc(webhooks.createdAt));
}

// One page of the webhooks, newest first.
export async function listWebhooksPage(
  env: Env,
  page: Page,
): Promise<{ rows: WebhookRow[]; has_more: boolean }> {
  const { rows, has_more } = await pageQuery<{ id: string }>(
    env,
    "webhooks",
    [],
    [],
    page,
  );

  const ids = rows.map((r) => r.id);

  const found = ids.length
    ? await getDb(env).select().from(webhooks).where(inArray(webhooks.id, ids))
    : [];

  return { rows: inPageOrder(found, ids), has_more };
}

export async function getWebhook(env: Env, id: string): Promise<WebhookRow> {
  const row = await getDb(env).query.webhooks.findFirst({
    where: eq(webhooks.id, id),
  });

  if (!row) throw notFound("Webhook");

  return row;
}

export async function updateWebhook(
  env: Env,
  id: string,
  input: JsonObject,
): Promise<WebhookRow> {
  await getWebhook(env, id);
  const patch: Partial<WebhookRow> = {};

  if (input.endpoint !== undefined)
    patch.endpoint = checkEndpoint(input.endpoint);

  if (input.events !== undefined) patch.events = checkEvents(input.events);

  if (input.status !== undefined) {
    if (input.status !== "enabled" && input.status !== "disabled") {
      throw validation("The `status` must be `enabled` or `disabled`.");
    }

    patch.status = input.status;
  }

  if (Object.keys(patch).length) {
    await getDb(env).update(webhooks).set(patch).where(eq(webhooks.id, id));
  }

  return getWebhook(env, id);
}

export async function deleteWebhook(env: Env, id: string): Promise<void> {
  await getWebhook(env, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(id),
    env.DB.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").bind(
      id,
    ),
  ]);
}

export async function rotateSecret(env: Env, id: string): Promise<string> {
  await getWebhook(env, id);
  const secret = newSecret();
  await getDb(env).update(webhooks).set({ secret }).where(eq(webhooks.id, id));

  return secret;
}

export async function sendTestEvent(
  env: Env,
  id: string,
  type?: string,
): Promise<string> {
  const hook = await getWebhook(env, id);
  const messageId = newMessageId();
  await env.HOOKS_QUEUE.send({
    webhookId: hook.id,
    messageId,
    eventId: null,
    body: testBody(type && WEBHOOK_EVENTS.includes(type) ? type : "email.sent"),
  });

  return messageId;
}

// Sends one stored delivery again, with the same svix-id.
export async function redeliver(
  env: Env,
  webhookId: string,
  deliveryId: string,
): Promise<void> {
  const d = await env.DB.prepare(
    "SELECT message_id, event_id, request_body FROM webhook_deliveries WHERE id = ? AND webhook_id = ?",
  )
    .bind(deliveryId, webhookId)
    .first<{
      message_id: string;
      event_id: string | null;
      request_body: string;
    }>();

  if (!d) throw notFound("Delivery");
  await env.HOOKS_QUEUE.send({
    webhookId,
    messageId: d.message_id,
    eventId: d.event_id,
    body: d.event_id ? null : d.request_body,
  });
}
