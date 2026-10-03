import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { type DomainRecord, type DomainStatus, domains } from "../db/schema";
import type { Env } from "../env";
import {
  Cloudflare,
  CloudflareError,
  type DnsStatus,
  hasToken,
} from "../lib/cloudflare";
import { ApiError, notFound, validation } from "../lib/errors";
import { isHostname } from "../lib/http";
import {
  isBoolean,
  isString,
  type JsonObject,
  type JsonValue,
} from "../lib/json";
import { getSettings } from "../lib/settings";
import { errorText } from "../lib/system-events";
import { iso } from "../lib/time";

export type DomainRow = typeof domains.$inferSelect;

function checkName(value: JsonValue | undefined): string {
  if (!isString(value) || !value.trim())
    throw validation("Missing `name` field.");
  const name = value.trim().toLowerCase().replace(/\.$/, "");

  if (!isHostname(name))
    throw validation(
      "The `name` must be a domain name, for example `mail.example.com`.",
    );

  return name;
}

// The domain fields of Resend that fullsend cannot change. Cloudflare
// Email Sending sets the TLS mode, the return path and the region. The
// tracking hostname is a setting of the whole deploy. A value that equals
// what fullsend does is accepted. Any other value gets a 422, so the
// caller does not think that fullsend honored it.
const REGION = "global";

const TLS_MODES = ["opportunistic", "enforced"];

const RETURN_PATH = "send";

function present(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null;
}

function checkUnsupported(input: JsonObject, create: boolean): void {
  const { region, custom_return_path: path, tls } = input;

  if (create && present(region) && region !== REGION) {
    throw validation(
      `fullsend sends from the "${REGION}" region only. Remove \`region\` or set it to "${REGION}".`,
    );
  }

  if (create && present(path) && path !== RETURN_PATH) {
    throw validation(
      `fullsend cannot set \`custom_return_path\`: Cloudflare sets the return path. Remove it or set it to "${RETURN_PATH}".`,
    );
  }

  if (present(tls)) {
    if (!isString(tls) || !TLS_MODES.includes(tls)) {
      throw validation("`tls` must be `opportunistic` or `enforced`.");
    }

    if (tls === "enforced") {
      throw validation(
        "fullsend cannot enforce TLS: Cloudflare sets the TLS mode. Remove `tls` or set it to `opportunistic`.",
      );
    }
  }

  if (present(input.tracking_subdomain)) {
    throw validation(
      "fullsend cannot set `tracking_subdomain`. The tracking hostname is one setting for the deploy. Change it in the dashboard.",
    );
  }
}

function needToken(env: Env): Cloudflare {
  if (!hasToken(env)) {
    throw new ApiError(
      403,
      "validation_error",
      "fullsend has no Cloudflare API token. Onboard the domain in the Cloudflare dashboard, then import it in the fullsend dashboard.",
    );
  }

  return new Cloudflare(env);
}

// Maps a Cloudflare DNS status to the Resend domain status.
function statusOf(dns: DnsStatus, enabled = true): DomainStatus {
  if (dns.status === "misconfigured") return "failed";

  if (dns.status === "unconfigured") return "pending";

  return enabled ? "verified" : "pending";
}

function recordKind(type: string, name: string, content: string): string {
  if (type === "MX") return "SPF";

  if (name.includes("_domainkey")) return "DKIM";

  if (name.startsWith("_dmarc")) return "DMARC";

  if (content.startsWith("v=spf1")) return "SPF";

  return type;
}

const ERROR_PREFIX = new Map([
  ["MX", "mx."],
  ["SPF", "spf."],
  ["DKIM", "dkim."],
  ["DMARC", "dmarc."],
]);

// Converts the Cloudflare records to Resend's shape.
export function toRecords(dns: DnsStatus): DomainRecord[] {
  const codes = (dns.errors ?? []).map((e) => e.code);

  return (dns.records ?? []).map((r) => {
    const kind = recordKind(r.type, r.name, r.content);
    const prefix = r.type === "MX" ? "mx." : (ERROR_PREFIX.get(kind) ?? "?");
    let status = "verified";

    if (codes.some((c) => c.startsWith(prefix))) status = "failed";
    else if (dns.status === "unconfigured") status = "pending";

    const rec: DomainRecord = {
      record: kind,
      name: r.name,
      type: r.type,
      ttl: !r.ttl || r.ttl === 1 ? "Auto" : String(r.ttl),
      status,
      value: r.content,
    };

    if (r.priority !== undefined) rec.priority = r.priority;

    return rec;
  });
}

export function listDomains(env: Env): Promise<DomainRow[]> {
  return getDb(env).select().from(domains).orderBy(desc(domains.createdAt));
}

export async function getDomain(env: Env, id: string): Promise<DomainRow> {
  const row = await getDb(env).query.domains.findFirst({
    where: eq(domains.id, id),
  });

  if (!row) throw notFound("Domain");

  return row;
}

async function defaultTracking(env: Env) {
  const s = await getSettings(env);

  return {
    open: s.default_open_tracking === "true",
    click: s.default_click_tracking === "true",
  };
}

async function insertDomain(
  env: Env,
  input: {
    name: string;
    zoneId: string | null;
    tag: string | null;
    status: DomainStatus;
    records: DomainRecord[];
    source: string;
    openTracking?: boolean;
    clickTracking?: boolean;
  },
): Promise<DomainRow> {
  const exists = await getDb(env).query.domains.findFirst({
    where: eq(domains.name, input.name),
  });

  if (exists)
    throw validation(`The ${input.name} domain is already in fullsend.`);
  const tracking = await defaultTracking(env);

  const row: DomainRow = {
    id: crypto.randomUUID(),
    name: input.name,
    cfZoneId: input.zoneId,
    cfSubdomainTag: input.tag,
    status: input.status,
    region: "global",
    openTracking: input.openTracking ?? tracking.open,
    clickTracking: input.clickTracking ?? tracking.click,
    eventSubscriptionId: null,
    eventSubscriptionError: null,
    records: input.records,
    source: input.source,
    checkedAt: Date.now(),
    createdAt: Date.now(),
  };

  await getDb(env).insert(domains).values(row);

  return row;
}

function cfError(cause: unknown): never {
  if (cause instanceof CloudflareError) {
    throw new ApiError(422, "validation_error", `Cloudflare: ${cause.message}`);
  }

  throw cause;
}

// Onboards a domain through the Email Sending API, then makes its event
// subscription.
export async function createDomain(
  env: Env,
  input: JsonObject,
): Promise<DomainRow> {
  const name = checkName(input.name);
  checkUnsupported(input, true);
  const cf = needToken(env);

  try {
    const zone = await cf.zoneFor(name);

    if (!zone)
      throw validation(
        `No active Cloudflare zone in this account holds ${name}.`,
      );

    const existing = (await cf.sendingDomains(zone.id)).find(
      (d) => d.name === name,
    );

    const sending = existing ?? (await cf.createSendingDomain(zone.id, name));
    const dns = await cf.dnsStatus(zone.id, sending.tag);

    const row = await insertDomain(env, {
      name,
      zoneId: zone.id,
      tag: sending.tag,
      status: statusOf(dns, sending.enabled),
      records: toRecords(dns),
      source: existing ? "import" : "api",
      openTracking: isBoolean(input.open_tracking)
        ? input.open_tracking
        : undefined,
      clickTracking: isBoolean(input.click_tracking)
        ? input.click_tracking
        : undefined,
    });

    return await ensureSubscription(env, row);
  } catch (err) {
    return cfError(err);
  }
}

// Adds a domain that the owner onboarded in the Cloudflare dashboard.
// Without a token, fullsend cannot check it and trusts the owner.
export async function importDomain(
  env: Env,
  input: JsonObject,
): Promise<DomainRow> {
  const name = checkName(input.name);

  if (!hasToken(env)) {
    return insertDomain(env, {
      name,
      zoneId: null,
      tag: null,
      status: "verified",
      records: [],
      source: "import",
    });
  }

  const cf = new Cloudflare(env);

  try {
    const zone = await cf.zoneFor(name);

    if (!zone)
      throw validation(
        `No active Cloudflare zone in this account holds ${name}.`,
      );

    const sending = (await cf.sendingDomains(zone.id)).find(
      (d) => d.name === name,
    );

    if (!sending)
      throw validation(
        `${name} is not onboarded to Email Sending in Cloudflare.`,
      );
    const dns = await cf.dnsStatus(zone.id, sending.tag);

    const row = await insertDomain(env, {
      name,
      zoneId: zone.id,
      tag: sending.tag,
      status: statusOf(dns, sending.enabled),
      records: toRecords(dns),
      source: "import",
    });

    return await ensureSubscription(env, row);
  } catch (err) {
    return cfError(err);
  }
}

// Reads the DNS status from Cloudflare. With `fix`, Cloudflare first adds
// the records that are missing.
export async function syncDomain(
  env: Env,
  row: DomainRow,
  opts: { fix?: boolean } = {},
): Promise<DomainRow> {
  if (!hasToken(env) || !row.cfZoneId || !row.cfSubdomainTag) return row;
  const cf = new Cloudflare(env);
  let dns = await cf.dnsStatus(row.cfZoneId, row.cfSubdomainTag);

  if (opts.fix && dns.status !== "ready") {
    try {
      dns = await cf.fixDns(row.cfZoneId, row.cfSubdomainTag);
    } catch (err) {
      console.warn(
        JSON.stringify({
          evt: "domains.dns_fix_failed",
          domain: row.name,
          error: errorText(err),
        }),
      );
    }
  }

  const patch = {
    status: statusOf(dns),
    records: toRecords(dns),
    checkedAt: Date.now(),
  };

  await getDb(env).update(domains).set(patch).where(eq(domains.id, row.id));

  return { ...row, ...patch };
}

export async function verifyDomain(env: Env, id: string): Promise<DomainRow> {
  const row = await getDomain(env, id);

  try {
    return await syncDomain(env, row, { fix: true });
  } catch (err) {
    return cfError(err);
  }
}

// Makes the event subscription of a domain when it is missing. A failure
// is stored on the row, so the UI can show the manual steps.
export async function ensureSubscription(
  env: Env,
  row: DomainRow,
): Promise<DomainRow> {
  if (!hasToken(env) || !row.cfZoneId) return row;
  const cf = new Cloudflare(env);
  let patch: Partial<DomainRow>;

  try {
    if (row.eventSubscriptionId) {
      try {
        const sub = await cf.eventSubscription(row.eventSubscriptionId);

        if (sub.id) return row;
      } catch (err) {
        if (!(err instanceof CloudflareError) || err.status !== 404) throw err;
      }
    }

    const queueId = await cf.queueId(env.EVENTS_QUEUE_NAME);

    if (!queueId)
      throw new Error(`The queue ${env.EVENTS_QUEUE_NAME} does not exist.`);

    const sub = await cf.createEventSubscription({
      name: `fullsend-${row.name}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 60),
      zoneId: row.cfZoneId,
      domain: row.name,
      queueId,
    });

    patch = { eventSubscriptionId: sub.id, eventSubscriptionError: null };
  } catch (err) {
    patch = {
      eventSubscriptionError: err instanceof Error ? err.message : String(err),
    };
  }

  await getDb(env).update(domains).set(patch).where(eq(domains.id, row.id));

  return { ...row, ...patch };
}

export async function updateDomain(
  env: Env,
  id: string,
  input: JsonObject,
): Promise<DomainRow> {
  const row = await getDomain(env, id);
  const patch: Partial<DomainRow> = {};
  checkUnsupported(input, false);

  if (input.open_tracking !== undefined) {
    if (!isBoolean(input.open_tracking))
      throw validation("`open_tracking` must be a boolean.");
    patch.openTracking = input.open_tracking;
  }

  if (input.click_tracking !== undefined) {
    if (!isBoolean(input.click_tracking))
      throw validation("`click_tracking` must be a boolean.");
    patch.clickTracking = input.click_tracking;
  }

  if (Object.keys(patch).length) {
    await getDb(env).update(domains).set(patch).where(eq(domains.id, id));
  }

  return { ...row, ...patch };
}

// Removes the domain from fullsend. A domain that fullsend onboarded is
// also offboarded from Email Sending, which removes its DNS records.
export async function deleteDomain(env: Env, id: string): Promise<void> {
  const row = await getDomain(env, id);

  if (hasToken(env)) {
    const cf = new Cloudflare(env);

    if (row.eventSubscriptionId) {
      await cf.deleteEventSubscription(row.eventSubscriptionId).catch((err) =>
        console.warn(
          JSON.stringify({
            evt: "domains.subscription_delete_failed",
            error: errorText(err),
          }),
        ),
      );
    }

    if (row.source === "api" && row.cfZoneId && row.cfSubdomainTag) {
      await cf
        .deleteSendingDomain(row.cfZoneId, row.cfSubdomainTag)
        .catch((err) =>
          console.warn(
            JSON.stringify({
              evt: "domains.offboard_failed",
              error: errorText(err),
            }),
          ),
        );
    }
  }

  await getDb(env).delete(domains).where(eq(domains.id, id));
}

// The Resend shape of a domain. Only a single domain has `records`.
export interface DomainJson {
  object: "domain";
  id: string;
  name: string;
  status: DomainStatus;
  created_at: string;
  region: string;
  capabilities: { sending: string; receiving: string };
  open_tracking: boolean;
  click_tracking: boolean;
  records?: DomainRecord[];
}

export function domainJson(row: DomainRow, withRecords = false): DomainJson {
  const out: DomainJson = {
    object: "domain",
    id: row.id,
    name: row.name,
    status: row.status,
    created_at: iso(row.createdAt),
    region: row.region,
    capabilities: { sending: "enabled", receiving: "disabled" },
    open_tracking: row.openTracking,
    click_tracking: row.clickTracking,
  };

  if (withRecords) out.records = row.records;

  return out;
}
