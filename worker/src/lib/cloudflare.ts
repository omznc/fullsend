// A small client for the Cloudflare API. Every call needs CF_API_TOKEN
// and CF_ACCOUNT_ID.

import type { Env } from "../env";
import type { JsonValue } from "./json";

const BASE = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number };
}

export class CloudflareError extends Error {
  readonly status: number;
  readonly code: number | null;

  constructor(message: string, status: number, code: number | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class NoTokenError extends Error {
  constructor() {
    super("CF_API_TOKEN and CF_ACCOUNT_ID are not set");
  }
}

export function hasToken(env: Env): boolean {
  return Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);
}

export class Cloudflare {
  readonly accountId: string;
  private readonly token: string;

  constructor(env: Env) {
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) throw new NoTokenError();
    this.token = env.CF_API_TOKEN;
    this.accountId = env.CF_ACCOUNT_ID;
  }

  private async raw<T>(
    path: string,
    init?: RequestInit,
  ): Promise<CfEnvelope<T>> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    });

    let body: CfEnvelope<T>;

    try {
      body = await res.json<CfEnvelope<T>>();
    } catch {
      throw new CloudflareError(
        `Cloudflare API returned ${res.status} for ${path}`,
        res.status,
        null,
      );
    }

    if (!res.ok || !body.success) {
      const first = body.errors?.[0];
      throw new CloudflareError(
        first?.message ?? `Cloudflare API returned ${res.status}`,
        res.status,
        first?.code ?? null,
      );
    }

    return body;
  }

  async call<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.raw<T>(path, init)).result;
  }

  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";

    for (let page = 1; page < 100; page++) {
      const body = await this.raw<T[]>(`${path}${sep}page=${page}&per_page=50`);
      out.push(...body.result);
      const info = body.result_info;

      if (!info || info.page >= info.total_pages) break;
    }

    return out;
  }

  private get acct() {
    return `/accounts/${this.accountId}`;
  }

  // Token and account

  async verifyToken(): Promise<{ id: string; status: string }> {
    try {
      return await this.call(`${this.acct}/tokens/verify`);
    } catch {
      return await this.call("/user/tokens/verify");
    }
  }

  account(): Promise<{ id: string; name: string }> {
    return this.call(this.acct);
  }

  // Zones

  zones(): Promise<Zone[]> {
    return this.all<Zone>(`/zones?status=active&account.id=${this.accountId}`);
  }

  // Finds the zone of a hostname: the longest zone name that is a suffix.
  async zoneFor(hostname: string): Promise<Zone | null> {
    const zones = await this.zones();
    const host = hostname.toLowerCase();
    let best: Zone | null = null;

    for (const z of zones) {
      if (host === z.name || host.endsWith(`.${z.name}`)) {
        if (!best || z.name.length > best.name.length) best = z;
      }
    }

    return best;
  }

  // Email Sending

  sendingDomains(zoneId: string): Promise<SendingDomain[]> {
    return this.call(`/zones/${zoneId}/email/sending/subdomains`);
  }

  createSendingDomain(zoneId: string, name: string): Promise<SendingDomain> {
    return this.call(`/zones/${zoneId}/email/sending/subdomains`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async deleteSendingDomain(zoneId: string, tag: string): Promise<void> {
    await this.call<JsonValue>(
      `/zones/${zoneId}/email/sending/subdomains/${tag}`,
      { method: "DELETE" },
    );
  }

  dnsStatus(zoneId: string, tag: string): Promise<DnsStatus> {
    return this.call(
      `/zones/${zoneId}/email/sending/subdomains/${tag}/dns/status`,
    );
  }

  fixDns(zoneId: string, tag: string): Promise<DnsStatus> {
    return this.call(`/zones/${zoneId}/email/sending/subdomains/${tag}/dns`, {
      method: "POST",
    });
  }

  suppressions(): Promise<CfSuppression[]> {
    return this.call(`${this.acct}/email/sending/suppressions`);
  }

  // Queues and event subscriptions

  async queueId(name: string): Promise<string | null> {
    const queues = await this.all<{ queue_id: string; queue_name: string }>(
      `${this.acct}/queues`,
    );

    return queues.find((q) => q.queue_name === name)?.queue_id ?? null;
  }

  createEventSubscription(input: {
    name: string;
    zoneId: string;
    domain: string;
    queueId: string;
  }): Promise<{ id: string }> {
    return this.call(`${this.acct}/event_subscriptions/subscriptions`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        enabled: true,
        source: {
          type: "email.sending",
          zone_id: input.zoneId,
          domain: input.domain,
        },
        destination: { type: "queues.queue", queue_id: input.queueId },
        events: [
          "message.delivered",
          "message.deferred",
          "message.bounced",
          "message.failed",
          "message.rejected",
          "message.complained",
        ],
      }),
    });
  }

  eventSubscription(id: string): Promise<{ id: string; enabled: boolean }> {
    return this.call(`${this.acct}/event_subscriptions/subscriptions/${id}`);
  }

  async deleteEventSubscription(id: string): Promise<void> {
    await this.call<JsonValue>(
      `${this.acct}/event_subscriptions/subscriptions/${id}`,
      { method: "DELETE" },
    );
  }

  // Access

  accessOrganization(): Promise<{ auth_domain: string; name: string }> {
    return this.call(`${this.acct}/access/organizations`);
  }

  accessApps(): Promise<AccessApp[]> {
    return this.call(`${this.acct}/access/apps`);
  }

  createAccessApp(body: AccessAppInput): Promise<AccessApp> {
    return this.call(`${this.acct}/access/apps`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  // Workers

  async putSecret(script: string, name: string, value: string): Promise<void> {
    await this.call<JsonValue>(
      `${this.acct}/workers/scripts/${script}/secrets`,
      {
        method: "PUT",
        body: JSON.stringify({ name, text: value, type: "secret_text" }),
      },
    );
  }

  // Workers custom domains

  workerDomains(service: string): Promise<WorkerDomain[]> {
    return this.call(`${this.acct}/workers/domains?service=${service}`);
  }

  attachWorkerDomain(input: {
    hostname: string;
    service: string;
    zoneId: string;
  }): Promise<WorkerDomain> {
    return this.call(`${this.acct}/workers/domains`, {
      method: "PUT",
      body: JSON.stringify({
        hostname: input.hostname,
        service: input.service,
        zone_id: input.zoneId,
        environment: "production",
      }),
    });
  }
}

export interface Zone {
  id: string;
  name: string;
  status: string;
}

export interface SendingDomain {
  tag: string;
  name: string;
  enabled: boolean;
  dkim_selector?: string;
  return_path_domain?: string;
  created?: string;
}

export interface CfDnsRecord {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
}

export interface DnsStatus {
  status: "ready" | "unconfigured" | "unlocked" | "misconfigured";
  records?: CfDnsRecord[];
  errors?: { code: string; missing?: CfDnsRecord; existing?: CfDnsRecord }[];
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

export interface AccessApp {
  id: string;
  name: string;
  aud: string;
  domain?: string;
}

// The body of POST /access/apps, as the setup sends it.
export interface AccessAppInput {
  name: string;
  type: string;
  domain: string;
  destinations: { type: string; uri: string }[];
  session_duration?: string;
  app_launcher_visible: boolean;
  policies: AccessPolicy[];
}

export interface AccessPolicy {
  name: string;
  decision: "allow" | "bypass";
  include: AccessRule[];
}

// An include rule of an Access policy: one email, or everyone.
export type AccessRule =
  | { email: { email: string } }
  | { everyone: Record<string, never> };

export interface WorkerDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
}
