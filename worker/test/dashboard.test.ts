import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/dashboard/auth";
import { call } from "./helpers";

const json = {
  "Content-Type": "application/json",
  "X-Fullsend-Dashboard": "1",
};

// The last cookie in the response that has a value. A response can also
// delete a cookie.
function cookieFrom(res: Response): string {
  const set = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="));

  return set.at(-1) ?? "";
}

describe("dashboard auth", () => {
  it("starts locked and fails closed", async () => {
    const session = await (
      await call("/api/session")
    ).json<{ state: string }>();

    expect(session.state).toBe("locked");
    expect((await call("/api/emails")).status).toBe(401);
    expect((await call("/api/setup/access")).status).toBe(401);
  });

  it("needs the dashboard header on a change", async () => {
    const res = await call("/api/setup/unlock", {
      method: "POST",
      body: JSON.stringify({ token: "x" }),
    });

    expect(res.status).toBe(400);
  });

  it("opens the Access setup with the setup token only", async () => {
    const wrong = await call("/api/setup/unlock", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ token: "nope" }),
    });

    expect(wrong.status).toBe(403);

    const ok = await call("/api/setup/unlock", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ token: "test-setup-token" }),
    });

    expect(ok.status).toBe(200);
    const cookie = cookieFrom(ok);

    const session = await (
      await call("/api/session", { headers: { Cookie: cookie } })
    ).json<{ state: string }>();

    expect(session.state).toBe("access_setup");

    const access = await call("/api/setup/access", {
      headers: { Cookie: cookie },
    });

    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
      automatic: false,
      fix: "token_missing",
      public_paths: expect.arrayContaining(["/emails", "/t"]),
    });

    // The setup cookie does not open the dashboard data.
    expect(
      (await call("/api/emails", { headers: { Cookie: cookie } })).status,
    ).toBe(401);
  });

  it("locks the setup token after Access is set up", async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('access_team_domain', 'team.cloudflareaccess.com'), ('access_aud', 'aud123')",
    ).run();

    const res = await call("/api/setup/unlock", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ token: "test-setup-token" }),
    });

    expect(res.status).toBe(403);

    // The UI itself needs an Access token now.
    const ui = await call("/");
    expect(ui.status).toBe(403);

    const session = await (
      await call("/api/session")
    ).json<{ state: string }>();

    expect(session.state).toBe("login");
  });
});

describe("password mode", () => {
  // The bodies of the setup, login and password routes.
  interface Body {
    token?: string;
    password?: string;
  }

  const post = (path: string, body: Body, cookie = "") =>
    call(path, {
      method: "POST",
      headers: cookie ? { ...json, Cookie: cookie } : json,
      body: JSON.stringify(body),
    });

  const emails = (cookie: string) =>
    call("/api/emails", { headers: { Cookie: cookie } });

  it("sets a password in the first setup", async () => {
    // D1 keeps the rows of the tests above in this file.
    await env.DB.prepare("DELETE FROM settings").run();

    // Without the setup cookie, nobody can choose the password.
    expect(
      (await post("/api/setup/password", { password: "x".repeat(20) })).status,
    ).toBe(401);

    const setup = cookieFrom(
      await post("/api/setup/unlock", { token: "test-setup-token" }),
    );

    expect(
      (await post("/api/setup/password", { password: "short" }, setup)).status,
    ).not.toBe(200);

    const first = await post(
      "/api/setup/password",
      { password: "correct horse battery" },
      setup,
    );

    expect(first.status).toBe(200);
    const session = cookieFrom(first);
    expect((await emails(session)).status).toBe(200);

    const state = await (
      await call("/api/session")
    ).json<{ state: string; mode: string }>();

    expect(state).toMatchObject({ state: "login", mode: "password" });

    // The setup token and the old setup cookie open nothing now.
    expect(
      (await post("/api/setup/unlock", { token: "test-setup-token" })).status,
    ).toBe(403);
    expect(
      (await post("/api/setup/password", { password: "y".repeat(20) }, setup))
        .status,
    ).toBe(401);

    // A setup token is not a session.
    const forged = await signToken(env, "setup", 60);
    expect((await emails(`fs_session=${forged}`)).status).toBe(401);

    expect(
      (await post("/api/auth/login", { password: "wrong horse battery" }))
        .status,
    ).toBe(403);

    const login = await post("/api/auth/login", {
      password: "correct horse battery",
    });

    expect(login.status).toBe(200);
    expect((await emails(cookieFrom(login))).status).toBe(200);

    // A new password ends the old sessions.
    const change = await post(
      "/api/settings/password",
      { password: "a new long password" },
      session,
    );

    expect(change.status).toBe(200);
    expect((await emails(session)).status).toBe(401);
    expect((await emails(cookieFrom(change))).status).toBe(200);
    expect(
      (await post("/api/auth/login", { password: "a new long password" }))
        .status,
    ).toBe(200);
  });

  it("counts the overview over the chosen period", async () => {
    // The test above set this password.
    const cookie = cookieFrom(
      await post("/api/auth/login", { password: "a new long password" }),
    );

    const day = 86_400_000;
    const now = Date.now();

    const insert = env.DB.prepare(
      "INSERT INTO email_events (id, email_id, type, created_at) VALUES (?, ?, 'sent', ?)",
    );

    await env.DB.batch(
      [100, 50, 2].map((ago) =>
        insert.bind(`ov-${ago}`, `ov-email-${ago}`, now - ago * day),
      ),
    );

    interface Overview {
      period: string;
      stats: { type: string; value: number; previous: number | null }[];
      series: unknown[];
    }

    const get = async (period: string) =>
      (
        await call(`/api/overview?period=${period}`, {
          headers: { Cookie: cookie },
        })
      ).json<Overview>();

    const sent = (o: Overview) => o.stats.find((s) => s.type === "sent")!;

    const week = await get("7d");
    expect(sent(week)).toEqual({ type: "sent", value: 1, previous: 0 });

    const month = await get("30d");
    expect(sent(month).value).toBe(1);

    // "all" starts at the first event and has no period before it.
    const all = await get("all");
    expect(all.period).toBe("all");
    expect(sent(all)).toEqual({ type: "sent", value: 3, previous: null });
    // 100 days in 7-day buckets.
    expect(all.series.length).toBeGreaterThan(14);
    expect(all.series.length).toBeLessThanOrEqual(16);

    // An unknown period falls back to 7 days, and says so.
    expect((await get("forever")).period).toBe("7d");
  });

  it("lists and clears the system events", async () => {
    const cookie = cookieFrom(
      await post("/api/auth/login", { password: "a new long password" }),
    );

    const now = Date.now();

    await env.DB.prepare("DELETE FROM system_events").run();
    await env.DB.prepare(
      `INSERT INTO system_events (id, created_at, level, source, message, detail) VALUES
       ('s1', ?1, 'error', 'cron', 'first', '{"a":1}'),
       ('s2', ?2, 'warn', 'events', 'second', NULL),
       ('s3', ?3, 'error', 'send', 'third', NULL),
       ('s4', ?4, 'error', 'send', 'too old', NULL)`,
    )
      .bind(now - 3000, now - 2000, now - 1000, now - 8 * 86_400_000)
      .run();

    interface Page {
      data: {
        id: string;
        created_at: string;
        level: string;
        message: string;
        detail: unknown;
      }[];
      has_more: boolean;
    }

    const get = (query: string) =>
      call(`/api/system-events${query}`, { headers: { Cookie: cookie } });

    expect((await call("/api/system-events")).status).toBe(401);

    const page1 = await (await get("?limit=2")).json<Page>();
    expect(page1.data.map((e) => e.id)).toEqual(["s3", "s2"]);
    expect(page1.has_more).toBe(true);
    expect(page1.data[0]!.created_at).toBe(new Date(now - 1000).toISOString());

    const page2 = await (await get("?limit=2&after=s2")).json<Page>();
    expect(page2.data.map((e) => e.id)).toEqual(["s1", "s4"]);
    expect(page2.has_more).toBe(false);
    expect(page2.data[0]!.detail).toEqual({ a: 1 });

    expect((await get("?limit=0")).status).toBe(422);
    expect((await get("?after=nope")).status).toBe(422);

    const overview = await (
      await call("/api/overview", { headers: { Cookie: cookie } })
    ).json<{
      system_events: {
        errors: number;
        warnings: number;
        latest_at: string | null;
      };
    }>();

    expect(overview.system_events).toEqual({
      errors: 2,
      warnings: 1,
      latest_at: new Date(now - 1000).toISOString(),
    });

    const noHeader = await call("/api/system-events", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(noHeader.status).toBe(400);

    const cleared = await call("/api/system-events", {
      method: "DELETE",
      headers: { ...json, Cookie: cookie },
    });

    expect(cleared.status).toBe(200);
    expect((await (await get("")).json<Page>()).data).toEqual([]);
  });

  // A login from one client address. The password is the one that the
  // first test of this block set last.
  const login = (ip: string, password = "a new long password") =>
    call("/api/auth/login", {
      method: "POST",
      headers: { ...json, "CF-Connecting-IP": ip },
      body: JSON.stringify({ password }),
    });

  const wrong = (ip: string) => login(ip, "not the password at all");

  it("limits the login attempts of each client", async () => {
    const guesses = await Promise.all(
      Array.from({ length: 8 }, () => wrong("203.0.113.7")),
    );

    const codes = guesses.map((r) => r.status).toSorted();

    expect(codes).toEqual([403, 403, 403, 403, 403, 429, 429, 429]);

    // The correct password from that client must wait too.
    const limited = await login("203.0.113.7");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await limited.json<{ error: string; retry_after: number }>();
    expect(body.error).toBe("too_many_attempts");
    expect(body.retry_after).toBeGreaterThan(0);

    // A different client is not limited.
    expect((await login("203.0.113.8")).status).toBe(200);
  });

  it("clears the count after a correct password", async () => {
    for (let i = 0; i < 4; i++)
      expect((await wrong("203.0.113.20")).status).toBe(403);

    expect((await login("203.0.113.20")).status).toBe(200);

    for (let i = 0; i < 4; i++)
      expect((await wrong("203.0.113.20")).status).toBe(403);
  });

  it("counts an IPv6 /64 as one client and a /48 as one site", async () => {
    // Five addresses in one /64 are one client.
    await Promise.all([1, 2, 3, 4, 5].map((n) => wrong(`2001:db8:1:1::${n}`)));
    expect((await login("2001:db8:1:1:ffff::1")).status).toBe(429);
    expect((await login("2001:db8:1:2::1")).status).toBe(200);

    // Twenty attempts from five /64 networks in one /48 lock the site.
    await Promise.all(
      [1, 2, 3, 4, 5].flatMap((net) =>
        [1, 2, 3, 4].map((n) => wrong(`2001:db8:2:${net}::${n}`)),
      ),
    );
    expect((await login("2001:db8:2:6::1")).status).toBe(429);
    expect((await login("2001:db8:3:1::1")).status).toBe(200);
  });

  it("limits the attempts of all clients in one minute", async () => {
    const minute = Math.floor(Date.now() / 60_000);

    const full = env.DB.prepare(
      "INSERT INTO auth_attempts (key, count, locked_until, updated_at) VALUES (?, 60, 0, 0) ON CONFLICT (key) DO UPDATE SET count = 60",
    );

    await env.DB.batch([
      full.bind(`login:all:${minute}`),
      full.bind(`login:all:${minute + 1}`),
    ]);

    expect((await login("203.0.113.30")).status).toBe(429);
    await env.DB.prepare(
      "DELETE FROM auth_attempts WHERE key LIKE 'login:all:%'",
    ).run();
    expect((await login("203.0.113.30")).status).toBe(200);
  });
});
