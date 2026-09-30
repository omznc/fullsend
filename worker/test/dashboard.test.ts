import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/dashboard/auth";
import worker from "../src/index";
import { call } from "./helpers";

const json = {
  "Content-Type": "application/json",
  "X-Fullsend-Dashboard": "1",
};

function cookieFrom(res: Response): string {
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
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
  const pwEnv = {
    ...env,
    AUTH_MODE: "password",
    ADMIN_PASSWORD: "correct horse battery",
  };

  const request = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request(`http://fullsend.test${path}`, init),
      pwEnv,
      createExecutionContext(),
    );

  it("does not accept a setup token as a session", async () => {
    const unlock = await request("/api/setup/unlock", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ token: "test-setup-token" }),
    });

    expect(unlock.status).toBe(403);

    const setup = await signToken(pwEnv, "setup", 60);

    const forged = await request("/api/emails", {
      headers: { Cookie: `fs_session=${setup}` },
    });

    expect(forged.status).toBe(401);

    const login = await request("/api/auth/login", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ password: "correct horse battery" }),
    });

    expect(login.status).toBe(200);

    const ok = await request("/api/emails", {
      headers: { Cookie: cookieFrom(login) },
    });

    expect(ok.status).toBe(200);
  });
});
