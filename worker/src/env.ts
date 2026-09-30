export interface SendMessage {
  emailId: string;
}

export interface HookMessage {
  webhookId: string;
  // The svix-id. The same for each attempt.
  messageId: string;
  // An email_events id, or null for a test event.
  eventId: string | null;
  // The full body for a test event. Null for a real event: the consumer
  // builds the body from the event row.
  body: string | null;
}

export interface Env {
  EMAIL: SendEmail;
  DB: D1Database;
  BODIES: R2Bucket;
  SEND_QUEUE: Queue<SendMessage>;
  HOOKS_QUEUE: Queue<HookMessage>;
  // Only Cloudflare Email Service writes to this queue. The binding exists
  // so that the deploy creates the queue (see wrangler.jsonc).
  EVENTS_QUEUE: Queue<never>;
  RATE_LIMITER: RateLimit;
  ASSETS: Fetcher;

  WORKER_NAME: string;
  EVENTS_QUEUE_NAME: string;

  SETUP_TOKEN?: string;
  SESSION_SECRET?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  AUTH_MODE?: string;
  ADMIN_PASSWORD?: string;
}
