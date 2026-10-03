import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DomainUpdatedEvent } from "resend";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { sessionSecret, setupCode } from "../src/lib/secrets";
import { createWebhook } from "../src/webhooks/service";
import { BASE } from "./helpers";

const ACCOUNT = "acc123";

const domainUpdated = z.object({
  type: z.literal("domain.updated"),
  created_at: z.string(),
  data: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    created_at: z.string(),
    region: z.string(),
    records: z.array(
      z.object({
        record: z.string(),
        name: z.string(),
        type: z.string(),
        ttl: z.string(),
        status: z.string(),
        value: z.string(),
        priority: z.number().optional(),
      }),
    ),
  }),
});

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

  it("sends domain.updated when the status changes, not before", async () => {
    fake = fakeCloudflare(
      baseRoutes({
        "GET /zones/zone1/email/sending/subdomains": [],
        "POST /zones/zone1/email/sending/subdomains": {
          tag: "tag9",
          name: "evt.example.com",
          enabled: true,
        },
        "GET /zones/zone1/email/sending/subdomains/tag9/dns/status": {
          ...READY,
          status: "misconfigured",
          errors: [{ code: "spf.missing" }],
        },
        "POST /zones/zone1/email/sending/subdomains/tag9/dns": READY,
      }),
    );

    await createWebhook(env, {
      endpoint: "https://hooks.example.com/domain",
      events: ["domain.updated"],
    });

    const queue = vi
      .spyOn(env.HOOKS_QUEUE, "sendBatch")
      .mockResolvedValue({
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      });

    try {
      const row = await createDomain(cfEnv, { name: "evt.example.com" });
      expect(queue).not.toHaveBeenCalled();

      await verifyDomain(cfEnv, row.id);
      expect(queue).toHaveBeenCalledTimes(1);

      const sent = queue.mock.calls[0]![0];
      expect(sent).toHaveLength(1);
      const message = [...sent][0]!.body;
      expect(message.eventId).toBeNull();

      // The schema is assigned to the SDK type, so a change of the SDK
      // type breaks the compile.
      const event: DomainUpdatedEvent = domainUpdated.parse(
        parseJsonText(message.body!),
      );

      expect(event.type).toBe("domain.updated");
      expect(event.data).toMatchObject({
        id: row.id,
        name: "evt.example.com",
        status: "verified",
        region: "global",
      });
      expect(event.data.records.length).toBeGreaterThan(0);

      // The status is the same now, so a second verify sends nothing.
      await verifyDomain(cfEnv, row.id);
      expect(queue).toHaveBeenCalledTimes(1);
    } finally {
      queue.mockRestore();
    }
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

describe("token setup", () => {
  const headers = {
    "Content-Type": "application/json",
    "X-Fullsend-Dashboard": "1",
  };

  // A Worker without CF_API_TOKEN and CF_ACCOUNT_ID.
  async function request(path: string, init: RequestInit = {}, base = BASE) {
    return worker.fetch(
      new Request(`${base}${path}`, init),
      env,
      createExecutionContext(),
    );
  }

  const claim = (body: JsonObject, base = BASE) =>
    request(
      "/api/setup/token",
      { method: "POST", headers, body: JSON.stringify(body) },
      base,
    );

  const secrets = () =>
    (fake?.calls ?? [])
      .filter((c) => c.method === "PUT" && c.path.includes("/secrets"))
      .map((c) => (isJsonObject(c.body) ? c.body.name : null));

  const ownRoutes = (account: string, domains: string[]) => ({
    [`GET /accounts/${account}/workers/domains`]: domains.map((hostname) => ({
      id: hostname,
      hostname,
      service: "fullsend",
    })),
    [`GET /accounts/${account}/workers/subdomain`]: { subdomain: "acme" },
    [`PUT /accounts/${account}/workers/scripts/fullsend/secrets`]: (
      call: Call,
    ) => ({ result: call.body }),
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("saves the token of the account that runs the Worker", async () => {
    fake = fakeCloudflare({
      "GET /accounts": [{ id: ACCOUNT, name: "Acme" }],
      ...ownRoutes(ACCOUNT, ["fullsend.test"]),
    });

    const res = await claim({ token: "cf-test-token" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, account_id: ACCOUNT });
    expect(secrets()).toEqual(["CF_ACCOUNT_ID", "CF_API_TOKEN"]);

    const put = fake.calls.find((c) => c.method === "PUT");

    expect(put?.body).toEqual({
      name: "CF_ACCOUNT_ID",
      text: ACCOUNT,
      type: "secret_text",
    });

    // The token also unlocked the setup.
    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;

    expect(cookie).toMatch(/^fs_setup=/);

    const session = await request("/api/session", {
      headers: { Cookie: cookie },
    });

    expect(await session.json()).toMatchObject({ state: "access_setup" });

    // This Worker version does not have the secrets yet.
    const status = await request("/api/setup/token", {
      headers: { Cookie: cookie },
    });

    expect(await status.json()).toEqual({ token_set: false });
  });

  it("matches the workers.dev URL of the account", async () => {
    fake = fakeCloudflare({
      "GET /accounts": [{ id: ACCOUNT, name: "Acme" }],
      ...ownRoutes(ACCOUNT, []),
    });

    const res = await claim(
      { token: "cf-test-token" },
      "https://fullsend.acme.workers.dev",
    );

    expect(res.status).toBe(200);
    expect(secrets()).toEqual(["CF_ACCOUNT_ID", "CF_API_TOKEN"]);
  });

  it("refuses a token of an account that does not run the Worker", async () => {
    fake = fakeCloudflare({
      "GET /accounts": [{ id: ACCOUNT, name: "Other" }],
      ...ownRoutes(ACCOUNT, ["other.example.com"]),
    });

    const res = await claim({ token: "cf-test-token" });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "wrong_account" });
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(secrets()).toEqual([]);
  });

  it("asks for the account ID when the token cannot list accounts", async () => {
    const id = "0123456789abcdef0123456789abcdef";

    fake = fakeCloudflare({
      "GET /accounts": () => null,
      ...ownRoutes(id, ["fullsend.test"]),
    });

    const first = await claim({ token: "cf-test-token" });

    expect(first.status).toBe(422);
    expect(await first.json()).toMatchObject({ error: "account_unknown" });

    const second = await claim({ token: "cf-test-token", account_id: id });

    expect(second.status).toBe(200);
    expect(secrets()).toEqual(["CF_ACCOUNT_ID", "CF_API_TOKEN"]);
  });

  it("needs a sign-in after the setup", async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('auth_mode', 'password'), ('password_hash', 'x')",
    ).run();
    fake = fakeCloudflare({});

    const res = await claim({ token: "cf-test-token" });

    expect(res.status).toBe(401);
    expect(fake.calls).toEqual([]);
  });
});

describe("generated secrets", () => {
  // A Worker without SESSION_SECRET and SETUP_TOKEN.
  const bare: Env = { ...env, SESSION_SECRET: "", SETUP_TOKEN: "" };

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("makes one session secret and keeps it", async () => {
    const first = await sessionSecret(bare);

    expect(first).toMatch(/^[\w-]{43}$/);
    expect(await sessionSecret(bare)).toBe(first);
    expect(await sessionSecret(cfEnv)).toBe("test-session-secret");
  });

  it("opens the setup with the generated setup code", async () => {
    const code = await setupCode(bare);

    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);

    const unlock = (token: string) =>
      worker.fetch(
        new Request(`${BASE}/api/setup/unlock`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fullsend-Dashboard": "1",
          },
          body: JSON.stringify({ token }),
        }),
        bare,
        createExecutionContext(),
      );

    expect((await unlock("test-setup-token")).status).toBe(403);
    expect((await unlock(` ${code.toLowerCase()} `)).status).toBe(200);
  });
});
