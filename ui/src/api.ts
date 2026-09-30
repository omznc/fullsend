// Client for the dashboard API (/api/*). Each request that changes data
// sends the X-Fullsend-Dashboard header: the Worker refuses a change
// without it, to block cross-site request forgery.
import {
  isJsonObject,
  isString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from "./lib/json";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: JsonValue;

  constructor(status: number, message: string, body: JsonValue) {
    super(message);
    this.status = status;
    this.body = body;
  }

  // The machine name of the error, for example "D1_ERROR".
  get code(): string | null {
    const b = this.body;

    if (!isJsonObject(b)) return null;

    if (isString(b.error)) return b.error;

    if (isString(b.name)) return b.name;

    return null;
  }
}

// The response body as JSON. Text that is not JSON becomes a message.
function parseBody(text: string): JsonValue {
  if (!text) return null;

  try {
    return parseJson(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers();

  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  if (method !== "GET") headers.set("X-Fullsend-Dashboard", "1");

  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    signal: init.signal,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const body = parseBody(await res.text());

  if (!res.ok) {
    const message =
      isJsonObject(body) && isString(body.message)
        ? body.message
        : res.statusText;

    throw new ApiRequestError(res.status, message, body);
  }

  // SAFETY: the Worker is in this codebase. The types in this file mirror
  // the JSON that worker/src/dashboard/ returns for each path.
  return body as T;
}

// Builds a query string. Empty values are left out.
export function qs(
  params: Record<string, string | number | null | undefined>,
): string {
  const p = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }

  const s = p.toString();

  return s ? `?${s}` : "";
}

export interface Session {
  state: "locked" | "access_setup" | "login" | "ready";
  mode: "access" | "password" | "dev";
  identity: string | null;
  access_configured: boolean;
  // SETUP_TOKEN replaces the generated setup code.
  setup_token_set: boolean;
  cloudflare_token_set: boolean;
  setup_completed: boolean;
  deploy_name: string;
  worker_url: string;
  api_hostname: string | null;
  tracking_hostname: string | null;
  logout_url: string;
}

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

export interface Email {
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  subject: string;
  status: EmailStatus;
  last_event: string;
  last_event_at: string;
  error: string | null;
  tags: { name: string; value: string }[];
  api_key: { id: string; name: string };
  domain_id: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
  message_id: string | null;
  size: number | null;
}

export interface EmailEvent {
  id: string;
  type: string;
  recipient: string | null;
  bot: string | null;
  data: JsonObject | null;
  created_at: string;
}

export interface EmailDetail extends Email {
  headers: Record<string, string>;
  attachments: {
    filename: string;
    content_type: string;
    size: number;
    content_id?: string;
  }[];
  suppressed: string[];
  body_available: boolean;
  events: EmailEvent[];
}

export interface EmailBody {
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
}

export interface List<T> {
  has_more: boolean;
  data: T[];
}

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

export interface Domain {
  id: string;
  name: string;
  status: DomainStatus;
  region: string;
  source: string;
  open_tracking: boolean;
  click_tracking: boolean;
  records: DomainRecord[];
  cf_zone_id: string | null;
  event_subscription: {
    id: string | null;
    status: "active" | "error" | "missing";
    error: string | null;
  };
  checked_at: string | null;
  created_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  permission: "full_access" | "sending_access";
  domain_id: string | null;
  rate_limit: number | null;
  last_used_at: string | null;
  created_at: string;
}

export interface Webhook {
  id: string;
  endpoint: string;
  events: string[];
  status: "enabled" | "disabled" | "failing";
  enabled: boolean;
  success_rate: number | null;
  attempts_7d: number;
  last_attempt_at: string | null;
  created_at: string;
  signing_secret?: string;
}

export interface Delivery {
  id: string;
  message_id: string;
  event_id: string | null;
  event_type: string;
  attempt: number;
  status_code: number | null;
  ok: boolean;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  request_body?: string;
  response_excerpt?: string | null;
}

export interface Suppression {
  address: string;
  reason: string;
  source: string;
  email_id: string | null;
  created_at: string;
}

export interface CfSuppression {
  id: string;
  email: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
  read_only: boolean;
  note?: string | null;
  scope?: { type: "account" } | { type: "sending_domain"; value: string };
}

export type RateLevel = "good" | "warning" | "danger" | null;

export interface Overview {
  period: "24h" | "7d" | "30d";
  total_emails: number;
  stats: { type: string; value: number; previous: number }[];
  series: { at: string; sent: number; delivered: number; bounced: number }[];
  bounce_rate: { value: number | null; level: RateLevel };
  complaint_rate: { value: number | null; level: RateLevel };
  recent_failures: {
    id: string;
    to: string[];
    subject: string;
    status: string;
    reason: string | null;
    at: string;
  }[];
  domains: Domain[];
}

export interface SearchResult {
  emails: {
    id: string;
    to: string[];
    subject: string;
    status: string;
    created_at: string;
  }[];
  domains: { id: string; name: string; status: string }[];
  api_keys: { id: string; name: string; prefix: string }[];
  webhooks: { id: string; endpoint: string; status: string }[];
}

export interface Probe {
  ok: boolean;
  error?: string;
}

export interface CloudflareStatus {
  token_set: boolean;
  valid: boolean;
  error?: string;
  account: { id: string; name: string } | null;
  permissions: {
    zone_read: Probe;
    email_sending: Probe;
    queues: Probe;
    access: Probe;
    access_org: Probe;
    workers_scripts: Probe;
  } | null;
}

export type PermKey = keyof NonNullable<CloudflareStatus["permissions"]>;

export type HostnameStatus = "unset" | "active" | "unknown" | "missing";

export interface Hostnames {
  worker_url: string;
  api_hostname: { hostname: string | null; status: HostnameStatus };
  tracking_hostname: { hostname: string | null; status: HostnameStatus };
  error: string | null;
}

export interface HostnameResult {
  hostname: string;
  status: "active" | "manual" | "error";
  error?: string;
}

export interface Settings {
  settings: {
    body_retention_days: string;
    row_retention_days: string;
    default_rate_limit: string;
    default_open_tracking: string;
    default_click_tracking: string;
    deploy_name: string;
    setup_completed: string;
  };
  api_hostname: string | null;
  tracking_hostname: string | null;
  access: { team_domain: string | null; configured: boolean };
  cloudflare_token_set: boolean;
  auth_mode: "access" | "password";
}

export interface SetupState {
  cloudflare_token_set: boolean;
  domains: Domain[];
  api_keys: number;
  emails: number;
  api_hostname: string | null;
  tracking_hostname: string | null;
  setup_completed: boolean;
}

export interface AccessInfo {
  automatic: boolean;
  reason: string | null;
  // Which "how to fix" steps apply. Null for an unknown error.
  fix: "token_missing" | "token_invalid" | "permissions" | null;
  // The permissions that the token does not have, for "permissions".
  missing: PermKey[];
  team_domain: string | null;
  hostname: string;
  hostname_is_workers_dev: boolean;
  public_paths: string[];
}

export interface AccessAutoResult {
  ok: boolean;
  steps: { step: string; ok: boolean; detail?: string }[];
  login_url?: string;
  message?: string;
}
