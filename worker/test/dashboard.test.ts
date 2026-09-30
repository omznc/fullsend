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
});
