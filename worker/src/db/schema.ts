import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { JsonObject } from "../lib/json";

// Time columns hold epoch milliseconds. The API shows them as ISO 8601.

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    permission: text("permission", {
      enum: ["full_access", "sending_access"],
    }).notNull(),
    domainId: text("domain_id"),
    // Requests per second.
    rateLimit: integer("rate_limit").notNull().default(10),
    lastUsedAt: integer("last_used_at"),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (t) => [uniqueIndex("api_keys_key_hash").on(t.keyHash)],
);

export type DomainStatus = "not_started" | "pending" | "verified" | "failed";

export interface DomainRecord {
  record: string;
  name: string;
  type: string;
  ttl: string;
  status: string;
  value: string;
  priority?: number;
}

export const domains = sqliteTable(
  "domains",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    cfZoneId: text("cf_zone_id"),
    cfSubdomainTag: text("cf_subdomain_tag"),
    status: text("status").$type<DomainStatus>().notNull(),
    region: text("region").notNull().default("global"),
    openTracking: integer("open_tracking", { mode: "boolean" }).notNull(),
    clickTracking: integer("click_tracking", { mode: "boolean" }).notNull(),
    eventSubscriptionId: text("event_subscription_id"),
    eventSubscriptionError: text("event_subscription_error"),
    records: text("records", { mode: "json" })
      .$type<DomainRecord[]>()
      .notNull()
      .default([]),
    // "api" when fullsend onboarded the domain, "import" when the owner
    // onboarded it in the Cloudflare dashboard.
    source: text("source").notNull().default("api"),
    checkedAt: integer("checked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("domains_name").on(t.name)],
);

export type EmailStatus =
  | "queued"
  | "scheduled"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "opened"
  | "clicked"
  | "failed"
  | "canceled"
  | "suppressed";

// A type alias, not an interface, so that a Tag is also a JsonObject.
export type Tag = {
  name: string;
  value: string;
};

export interface AttachmentMeta {
  filename: string;
  content_type: string;
  content_id?: string;
  size: number;
}

export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey(),
    // An API key id, "rpc:<caller>" or "dashboard:<identity>".
    apiKeyId: text("api_key_id").notNull(),
    domainId: text("domain_id"),
    from: text("from").notNull(),
    to: text("to", { mode: "json" }).$type<string[]>().notNull(),
    cc: text("cc", { mode: "json" }).$type<string[]>(),
    bcc: text("bcc", { mode: "json" }).$type<string[]>(),
    replyTo: text("reply_to", { mode: "json" }).$type<string[]>(),
    subject: text("subject").notNull(),
    tags: text("tags", { mode: "json" }).$type<Tag[]>(),
    headers: text("headers", { mode: "json" }).$type<Record<string, string>>(),
    attachments: text("attachments", { mode: "json" }).$type<
      AttachmentMeta[]
    >(),
    // Recipients that fullsend dropped because they are on the
    // suppression list.
    suppressed: text("suppressed", { mode: "json" }).$type<string[]>(),
    status: text("status").$type<EmailStatus>().notNull(),
    lastEvent: text("last_event").$type<EmailStatus>().notNull(),
    lastEventAt: integer("last_event_at").notNull(),
    // A short reason for a failed, bounced or suppressed email.
    error: text("error"),
    scheduledAt: integer("scheduled_at"),
    // Set when the cron put a scheduled email on the send queue.
    dispatchedAt: integer("dispatched_at"),
    // Set while a send consumer holds the email. It stops a second copy
    // of the queue message from sending the email again.
    claimedAt: integer("claimed_at"),
    cfMessageId: text("cf_message_id"),
    bodyKey: text("body_key"),
    size: integer("size").notNull().default(0),
    // How often the cron sweep put the stuck email on the send queue again.
    sweepCount: integer("sweep_count").notNull().default(0),
    // Set when the owner ignores a failed, bounced or complained email.
    // An ignored email does not count in the stats.
    ignoredAt: integer("ignored_at"),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (t) => [
    index("emails_created").on(t.createdAt, t.id),
    index("emails_status").on(t.status, t.createdAt),
    index("emails_scheduled").on(t.status, t.scheduledAt),
    index("emails_status_event").on(t.status, t.lastEventAt),
    uniqueIndex("emails_cf_message_id").on(t.cfMessageId),
    index("emails_api_key").on(t.apiKeyId, t.createdAt),
    index("emails_domain").on(t.domainId, t.createdAt),
  ],
);

export const emailEvents = sqliteTable(
  "email_events",
  {
    id: text("id").primaryKey(),
    emailId: text("email_id").notNull(),
    recipient: text("recipient"),
    type: text("type").$type<EmailStatus>().notNull(),
    data: text("data", { mode: "json" }).$type<JsonObject>(),
    // Set for an open or a click that looks automated. The event is kept,
    // but it does not change the email and it sends no webhook.
    bot: text("bot"),
    cfEventId: text("cf_event_id"),
    // True when the email update and the webhooks of the event are done.
    // A retry of the same Cloudflare event finishes an event that is not
    // done.
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("email_events_email").on(t.emailId, t.createdAt),
    index("email_events_type").on(t.type, t.createdAt),
    uniqueIndex("email_events_cf_event").on(t.cfEventId),
  ],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    apiKeyId: text("api_key_id").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state", { enum: ["pending", "done"] }).notNull(),
    response: text("response", { mode: "json" }).$type<unknown>(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.apiKeyId, t.key] }),
    index("idempotency_keys_created").on(t.createdAt),
  ],
);

export const suppressions = sqliteTable("suppressions", {
  address: text("address").primaryKey(),
  reason: text("reason", {
    enum: ["hard_bounce", "complaint", "manual"],
  }).notNull(),
  source: text("source").notNull(),
  emailId: text("email_id"),
  createdAt: integer("created_at").notNull(),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  endpoint: text("endpoint").notNull(),
  events: text("events", { mode: "json" }).$type<string[]>().notNull(),
  secret: text("secret").notNull(),
  status: text("status", { enum: ["enabled", "disabled"] }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id").notNull(),
    // The svix-id. It is the same for each attempt of one message.
    messageId: text("message_id").notNull(),
    eventId: text("event_id"),
    eventType: text("event_type").notNull(),
    attempt: integer("attempt").notNull(),
    statusCode: integer("status_code"),
    durationMs: integer("duration_ms"),
    requestBody: text("request_body").notNull(),
    responseExcerpt: text("response_excerpt"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("webhook_deliveries_webhook").on(t.webhookId, t.createdAt),
    index("webhook_deliveries_message").on(t.messageId),
    index("webhook_deliveries_created").on(t.createdAt),
  ],
);

// The count of password and setup code attempts for each client, each
// IPv6 site and each minute. See src/dashboard/attempts.ts.
export const authAttempts = sqliteTable("auth_attempts", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  lockedUntil: integer("locked_until").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// A failure that is not tied to one email, and a dead queue message. The
// payload of a dead queue message goes in detail (JSON).
export const systemEvents = sqliteTable(
  "system_events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    level: text("level", { enum: ["error", "warn"] }).notNull(),
    // For example "cron", "events", "hooks", "send" or "sweep".
    source: text("source").notNull(),
    message: text("message").notNull(),
    detail: text("detail", { mode: "json" }).$type<JsonObject>(),
  },
  (t) => [index("system_events_created").on(t.createdAt)],
);

// A log of the requests to the public API.
export const apiRequests = sqliteTable(
  "api_requests",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    apiKeyId: text("api_key_id"),
    errorName: text("error_name"),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [
    index("api_requests_created").on(t.createdAt),
    index("api_requests_status").on(t.status, t.createdAt),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
