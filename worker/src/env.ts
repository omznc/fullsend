export interface SendMessage {
  emailId: string;
}

export interface HookMessage {
  webhookId: string;
  // The svix-id. The same for each attempt.
  messageId: string;
  // An email_events id, or null when `body` has the full body.
  eventId: string | null;
  // The full body for a test event, a suppression event or a domain
  // event. Null for an email event: the consumer builds the body from the
  // event row.
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

  // Optional overrides. Without them, fullsend makes its own values and
  // keeps them in D1 (src/lib/secrets.ts).
  SETUP_TOKEN?: string;
  SESSION_SECRET?: string;
  // The first setup writes these two as Worker secrets from the token
  // that the owner pastes (POST /api/setup/token).
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  // Only "dev", for a local dashboard without a login. The first setup
  // chooses Access or a password, and D1 stores the choice.
  AUTH_MODE?: string;
}
