import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createDomain,
  deleteDomain,
  ensureSubscription,
  getDomain,
  importDomain,
  toRecords,
  verifyDomain,
} from "../src/domains/service";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { DnsStatus } from "../src/lib/cloudflare";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseJsonText,
} from "../src/lib/json";
import { BASE } from "./helpers";

const ACCOUNT = "acc123";

const API = "https://api.cloudflare.com/client/v4";

const cfEnv: Env = {
  ...env,
  CF_API_TOKEN: "cf-test-token",
  CF_ACCOUNT_ID: ACCOUNT,
};

interface Call {
  method: string;
  path: string;
  body: JsonValue;
}

interface Reply {
  status?: number;
  result: JsonValue;
}

type Handler = (call: Call) => Reply | null;

// A route gives a fixed result, or a handler makes the reply.
type Route = Handler | JsonValue;

function isHandler(route: Route): route is Handler {
  return typeof route === "function";
}

// A fake Cloudflare API. Each test gives the routes it needs. A call to a
// route that is not there fails the test.
function fakeCloudflare(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  // SAFETY: the stub implements the (input, init) form of fetch. That is
  // the only form that the Worker code calls.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);

    if (!req.url.startsWith(API)) return original(req);
    const url = new URL(req.url);
    const path = url.pathname.replace("/client/v4", "");
    const text = await req.text();

    const call: Call = {
      method: req.method,
      path: `${path}${url.search}`,
      body: text ? parseJsonText(text) : null,
    };

    calls.push(call);
    expect(req.headers.get("Authorization")).toBe("Bearer cf-test-token");
    const key = `${req.method} ${path}`;
    const route = routes[key];

    if (route === undefined) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 7003, message: `no route ${key}` }],
        },
        { status: 404 },
      );
    }

    const out = isHandler(route) ? route(call) : { result: route };

    if (!out) {
      return Response.json(
        { success: false, errors: [{ code: 1001, message: "not found" }] },
        { status: 404 },
      );
    }

    return Response.json(
      { success: true, errors: [], messages: [], result: out.result },
      { status: out.status ?? 200 },
    );
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const ZONE = { id: "zone1", name: "example.com", status: "active" };

const READY = {
  status: "ready",
  records: [
    {
      type: "TXT",
      name: "cf-bounce._domainkey.mail.example.com",
      content: "v=DKIM1; p=abc",
      ttl: 1,
    },
    {
      type: "MX",
      name: "cf-bounce.mail.example.com",
      content: "route1.mx.cloudflare.net",
      priority: 10,
      ttl: 1,
    },
    {
      type: "TXT",
      name: "cf-bounce.mail.example.com",
      content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
      ttl: 300,
    },
    {
      type: "TXT",
      name: "_dmarc.mail.example.com",
      content: "v=DMARC1; p=none",
      ttl: 1,
    },
  ],
} satisfies DnsStatus;

const baseRoutes = (extra: Record<string, Route> = {}) => ({
  "GET /zones": [ZONE],
  [`GET /accounts/${ACCOUNT}/queues`]: [
    { queue_id: "q-send", queue_name: "fullsend-send" },
    { queue_id: "q-events", queue_name: "fullsend-events" },
  ],
  [`POST /accounts/${ACCOUNT}/event_subscriptions/subscriptions`]: {
    id: "sub1",
  },
  ...extra,
});

let fake: ReturnType<typeof fakeCloudflare> | null = null;

beforeEach(() => {
  fake = null;
});

afterEach(() => {
  fake?.restore();
});

describe("toRecords", () => {
  it("maps the Cloudflare records to the Resend shape", () => {
    expect(toRecords(READY)).toEqual([
      expect.objectContaining({
        record: "DKIM",
        type: "TXT",
        ttl: "Auto",
        status: "verified",
      }),
      expect.objectContaining({
        record: "SPF",
        type: "MX",
        priority: 10,
        status: "verified",
      }),
      expect.objectContaining({ record: "SPF", type: "TXT", ttl: "300" }),
      expect.objectContaining({ record: "DMARC", type: "TXT" }),
    ]);
  });

  it("marks the record of an error as failed", () => {
    const records = toRecords({
      ...READY,
      status: "misconfigured",
      errors: [{ code: "dkim.missing" }],
    });

    expect(records.map((r) => r.status)).toEqual([
      "failed",
      "verified",
      "verified",
      "verified",
    ]);
  });

  it("marks each record pending for an unconfigured domain", () => {
    const records = toRecords({ ...READY, status: "unconfigured" });
    expect(records.every((r) => r.status === "pending")).toBe(true);
  });
});

describe("domain onboarding", () => {
  it("onboards a new domain and makes its event subscription", async () => {
    fake = fakeCloudflare(
      baseRoutes({
        "GET /zones/zone1/email/sending/subdomains": [],
        "POST /zones/zone1/email/sending/subdomains": {
          tag: "tag1",
          name: "mail.example.com",
          enabled: true,
        },
        "GET /zones/zone1/email/sending/subdomains/tag1/dns/status": READY,
      }),
    );
    const row = await createDomain(cfEnv, { name: "Mail.Example.com." });
    expect(row).toMatchObject({
      name: "mail.example.com",
      status: "verified",
      source: "api",
      cfZoneId: "zone1",
      cfSubdomainTag: "tag1",
      eventSubscriptionId: "sub1",
      eventSubscriptionError: null,
    });
    expect(row.records).toHaveLength(4);

    const create = fake.calls.find(
      (c) => c.method === "POST" && c.path.endsWith("/subdomains"),
    );

    expect(create?.body).toEqual({ name: "mail.example.com" });
    const sub = fake.calls.find((c) => c.path.includes("event_subscriptions"));
    expect(sub?.body).toMatchObject({
      enabled: true,
      source: {
        type: "email.sending",
        zone_id: "zone1",
        domain: "mail.example.com",
      },
      destination: { type: "queues.queue", queue_id: "q-events" },
    });
    expect(sub!.body).toMatchObject({
      events: expect.arrayContaining(["message.bounced"]),
    });
    expect((await getDomain(env, row.id)).eventSubscriptionId).toBe("sub1");
  });

  it("uses an onboarded subdomain and does not make a second one", async () => {
    fake = fakeCloudflare(
      baseRoutes({
        "GET /zones/zone1/email/sending/subdomains": [
          { tag: "tag2", name: "news.example.com", enabled: true },
        ],
        "GET /zones/zone1/email/sending/subdomains/tag2/dns/status": {
          ...READY,
          status: "unconfigured",
        },
      }),
    );
    const row = await createDomain(cfEnv, { name: "news.example.com" });
    expect(row).toMatchObject({ source: "import", status: "pending" });
    expect(
      fake.calls.some(
        (c) => c.method === "POST" && c.path.endsWith("/subdomains"),
      ),
    ).toBe(false);
  });

  it("refuses a domain outside the zones of the account", async () => {
    fake = fakeCloudflare(baseRoutes());
    await expect(
      createDomain(cfEnv, { name: "mail.other.net" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("imports only a domain that Cloudflare has onboarded", async () => {
    fake = fakeCloudflare(
      baseRoutes({
        "GET /zones/zone1/email/sending/subdomains": [
          { tag: "tag3", name: "imp.example.com", enabled: true },
        ],
        "GET /zones/zone1/email/sending/subdomains/tag3/dns/status": READY,
      }),
    );
    await expect(
      importDomain(cfEnv, { name: "missing.example.com" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    const row = await importDomain(cfEnv, { name: "imp.example.com" });
    expect(row).toMatchObject({ source: "import", status: "verified" });
  });

  it("stores the subscription error and keeps the domain", async () => {
    // The events queue is missing, so the subscription step fails.
    fake = fakeCloudflare(
      baseRoutes({
        "GET /zones/zone1/email/sending/subdomains": [],
        "POST /zones/zone1/email/sending/subdomains": {
          tag: "tag4",
          name: "err.example.com",
          enabled: true,
        },
        "GET /zones/zone1/email/sending/subdomains/tag4/dns/status": READY,
        [`GET /accounts/${ACCOUNT}/queues`]: [],
      }),
    );
    const row = await createDomain(cfEnv, { name: "err.example.com" });
    expect(row.eventSubscriptionId).toBeNull();
    expect(row.eventSubscriptionError).toContain("fullsend-events");
  });
});

describe("ensureSubscription", () => {
  it("keeps a subscription that exists", async () => {
    fake = fakeCloudflare(
      baseRoutes({
        "GET /zones/zone1/email/sending/subdomains": [],
        "POST /zones/zone1/email/sending/subdomains": {
          tag: "tag5",
          name: "keep.example.com",
          enabled: true,
        },
        "GET /zones/zone1/email/sending/subdomains/tag5/dns/status": READY,
        [`GET /accounts/${ACCOUNT}/event_subscriptions/subscriptions/sub1`]: {
          id: "sub1",
          enabled: true,
        },
      }),
    );
    const row = await createDomain(cfEnv, { name: "keep.example.com" });
    const before = fake.calls.length;
    const again = await ensureSubscription(cfEnv, row);
    expect(again.eventSubscriptionId).toBe("sub1");
    expect(fake.calls.slice(before).map((c) => c.method)).toEqual(["GET"]);
  });

  it("makes the subscription again when Cloudflare lost it", async () => {
    let created = 0;
    fake = fakeCloudflare(
      baseRoutes({
        "GET /zones/zone1/email/sending/subdomains": [],
        "POST /zones/zone1/email/sending/subdomains": {
          tag: "tag6",
          name: "lost.example.com",
          enabled: true,
        },
        "GET /zones/zone1/email/sending/subdomains/tag6/dns/status": READY,
        [`POST /accounts/${ACCOUNT}/event_subscriptions/subscriptions`]:
          () => ({
            result: { id: `sub-new-${++created}` },
          }),
        // No GET route for the subscription: the fake answers 404.
      }),
    );
    const row = await createDomain(cfEnv, { name: "lost.example.com" });
    expect(row.eventSubscriptionId).toBe("sub-new-1");
    const repaired = await ensureSubscription(cfEnv, row);
    expect(repaired.eventSubscriptionId).toBe("sub-new-2");
    expect((await getDomain(env, row.id)).eventSubscriptionId).toBe(
      "sub-new-2",
    );
  });
});

describe("verify and delete", () => {
  it("asks Cloudflare to fix the DNS records", async () => {
    fake = fakeCloudflare(
      baseRoutes({
        "GET /zones/zone1/email/sending/subdomains": [],
        "POST /zones/zone1/email/sending/subdomains": {
          tag: "tag7",
          name: "fix.example.com",
          enabled: true,
        },
        "GET /zones/zone1/email/sending/subdomains/tag7/dns/status": {
          ...READY,
          status: "misconfigured",
          errors: [{ code: "spf.missing" }],
        },
        "POST /zones/zone1/email/sending/subdomains/tag7/dns": READY,
      }),
    );
    const row = await createDomain(cfEnv, { name: "fix.example.com" });
    expect(row.status).toBe("failed");
    const fixed = await verifyDomain(cfEnv, row.id);
    expect(fixed.status).toBe("verified");
    expect((await getDomain(env, row.id)).status).toBe("verified");
  });

  it("offboards a domain that fullsend onboarded", async () => {
    fake = fakeCloudflare(
      baseRoutes({
        "GET /zones/zone1/email/sending/subdomains": [],
        "POST /zones/zone1/email/sending/subdomains": {
          tag: "tag8",
          name: "del.example.com",
          enabled: true,
        },
        "GET /zones/zone1/email/sending/subdomains/tag8/dns/status": READY,
        [`DELETE /accounts/${ACCOUNT}/event_subscriptions/subscriptions/sub1`]:
          null,
        "DELETE /zones/zone1/email/sending/subdomains/tag8": null,
      }),
    );
    const row = await createDomain(cfEnv, { name: "del.example.com" });
    await deleteDomain(cfEnv, row.id);
    const deletes = fake.calls.filter((c) => c.method === "DELETE");
    expect(deletes.map((c) => c.path)).toEqual([
      `/accounts/${ACCOUNT}/event_subscriptions/subscriptions/sub1`,
      "/zones/zone1/email/sending/subdomains/tag8",
    ]);
    await expect(getDomain(env, row.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("automatic Access setup", () => {
  const headers = {
    "Content-Type": "application/json",
    "X-Fullsend-Dashboard": "1",
  };

  async function request(path: string, init: RequestInit = {}) {
    return worker.fetch(
      new Request(`${BASE}${path}`, init),
      cfEnv,
      createExecutionContext(),
    );
  }

  async function unlock(): Promise<string> {
    const res = await request("/api/setup/unlock", {
      method: "POST",
      headers,
      body: JSON.stringify({ token: "test-setup-token" }),
    });

    expect(res.status).toBe(200);

    return (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  }

  it("tells a missing Access permission from a bad token", async () => {
    const cookie = await unlock();

    const access = async () =>
      (
        await request("/api/setup/access", { headers: { Cookie: cookie } })
      ).json();

    fake = fakeCloudflare({
      [`GET /accounts/${ACCOUNT}/tokens/verify`]: {
        id: "t1",
        status: "active",
      },
    });
    expect(await access()).toMatchObject({
      automatic: false,
      fix: "permissions",
      missing: ["access_org", "access"],
    });

    // Apps and Policies alone is not enough: the team domain needs the
    // organization permission.
    fake.restore();
    fake = fakeCloudflare({
      [`GET /accounts/${ACCOUNT}/tokens/verify`]: {
        id: "t1",
        status: "active",
      },
      [`GET /accounts/${ACCOUNT}/access/apps`]: [],
    });
    expect(await access()).toMatchObject({
      automatic: false,
      fix: "permissions",
      missing: ["access_org"],
    });

    fake.restore();
    fake = fakeCloudflare({});
    expect(await access()).toMatchObject({
      automatic: false,
      fix: "token_invalid",
    });
  });

  it("attaches the hostname and makes the two Access applications", async () => {
    const apps: JsonObject[] = [];
    fake = fakeCloudflare({
      "GET /zones": [ZONE],
      [`GET /accounts/${ACCOUNT}/access/organizations`]: {
        auth_domain: "team.cloudflareaccess.com",
        name: "team",
      },
      [`GET /accounts/${ACCOUNT}/workers/domains`]: [],
      [`PUT /accounts/${ACCOUNT}/workers/domains`]: (c: Call) => ({
        result: isJsonObject(c.body) ? { id: "wd1", ...c.body } : { id: "wd1" },
      }),
      [`GET /accounts/${ACCOUNT}/access/apps`]: [],
      [`POST /accounts/${ACCOUNT}/access/apps`]: (c: Call) => {
        const body = isJsonObject(c.body) ? c.body : {};
        apps.push(body);

        return {
          result: {
            id: `app${apps.length}`,
            aud: `aud${apps.length}`,
            ...body,
          },
        };
      },
    });
    const cookie = await unlock();

    const info = await request("/api/setup/access", {
      headers: { Cookie: cookie },
    });

    expect(await info.json()).toMatchObject({
      automatic: true,
      team_domain: "team.cloudflareaccess.com",
    });

    const res = await request("/api/setup/access/auto", {
      method: "POST",
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify({
        hostname: "Email.Example.com",
        emails: ["owner@example.com", "nope"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      login_url: "https://email.example.com/",
    });

    const attach = fake.calls.find((c) => c.method === "PUT");
    expect(attach?.body).toMatchObject({
      hostname: "email.example.com",
      service: "fullsend",
      zone_id: "zone1",
    });

    const [dashboard, api] = apps;
    expect(dashboard).toMatchObject({
      name: "fullsend dashboard",
      domain: "email.example.com",
      policies: [
        {
          decision: "allow",
          include: [{ email: { email: "owner@example.com" } }],
        },
      ],
    });
    expect(api).toMatchObject({
      name: "fullsend API",
      policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
    });

    const uris = z
      .array(z.object({ uri: z.string() }))
      .parse(api!.destinations)
      .map((d) => d.uri);

    expect(uris).toContain("email.example.com/emails");
    expect(uris).toContain("email.example.com/t/*");
    expect(uris).not.toContain("email.example.com/api/*");

    const settings = await env.DB.prepare(
      "SELECT key, value FROM settings WHERE key IN ('access_team_domain', 'access_aud', 'api_hostname')",
    ).all<{ key: string; value: string }>();

    expect(
      Object.fromEntries(settings.results.map((r) => [r.key, r.value])),
    ).toEqual({
      access_team_domain: "team.cloudflareaccess.com",
      access_aud: "aud1",
      api_hostname: "email.example.com",
    });

    // Access is on. The setup token is closed now.
    const again = await request("/api/setup/unlock", {
      method: "POST",
      headers,
      body: JSON.stringify({ token: "test-setup-token" }),
    });

    expect(again.status).toBe(403);
  });
});
