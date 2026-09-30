import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { Cloudflare, CloudflareError, hasToken } from "../lib/cloudflare";
import { safeEqual } from "../lib/crypto";
import { validation } from "../lib/errors";
import { asRecord, isHostname, readJson } from "../lib/http";
import { isString } from "../lib/json";
import { getSettings, type Settings, setSettings } from "../lib/settings";
import {
  authMode,
  type DashVars,
  requireSetup,
  resolveSession,
  SESSION_COOKIE,
  SESSION_TTL,
  SETUP_COOKIE,
  SETUP_TTL_SECONDS,
  signToken,
  verifyAccessJwt,
} from "./auth";

export const setupRoutes = new Hono<DashVars>();

// Paths that Access must keep public: the Resend API and the tracking
// links. A client with an API key or a mail client cannot log in.
export const PUBLIC_PATHS = [
  "/emails",
  "/domains",
  "/api-keys",
  "/webhooks",
  "/t",
  "/health",
];

const cookieOpts = (maxAge: number) => ({
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
  path: "/",
  maxAge,
});

// What the UI shows first: the locked page, the Access setup, the login
// form, or the dashboard.
setupRoutes.get("/session", async (c) => {
  const session = await resolveSession(c);
  const settings = await getSettings(c.env);
  let state: "locked" | "access_setup" | "login" | "ready";

  if (session.identity) state = "ready";
  else if (session.mode === "password") state = "login";
  else if (session.accessConfigured) state = "login";
  else state = session.setup ? "access_setup" : "locked";

  return c.json({
    state,
    mode: session.mode,
    identity: session.identity,
    access_configured: session.accessConfigured,
    setup_token_set: Boolean(c.env.SETUP_TOKEN),
    setup_completed: settings.setup_completed === "true",
    deploy_name: settings.deploy_name,
    worker_url: new URL(c.req.url).origin,
    api_hostname: settings.api_hostname || null,
    tracking_hostname: settings.tracking_hostname || null,
    logout_url:
      session.mode === "access" ? "/cdn-cgi/access/logout" : "/api/auth/logout",
  });
});

setupRoutes.post("/setup/unlock", async (c) => {
  const body = asRecord(await readJson(c));
  const settings = await getSettings(c.env);

  if (authMode(c.env, c.req.url) !== "access") {
    return c.json(
      {
        error: "not_access_mode",
        message: "The setup token is only for the Access setup.",
      },
      403,
    );
  }

  if (settings.access_team_domain && settings.access_aud) {
    return c.json(
      {
        error: "access_configured",
        message: "Access is set up. The setup token no longer opens anything.",
      },
      403,
    );
  }

  const expected = c.env.SETUP_TOKEN;

  if (!expected) {
    return c.json(
      {
        error: "no_setup_token",
        message: "SETUP_TOKEN is not set on the Worker.",
      },
      403,
    );
  }

  if (!isString(body.token) || !safeEqual(body.token.trim(), expected)) {
    return c.json(
      { error: "invalid_token", message: "The setup token is not correct." },
      403,
    );
  }

  setCookie(
    c,
    SETUP_COOKIE,
    await signToken(c.env, "setup", SETUP_TTL_SECONDS),
    cookieOpts(SETUP_TTL_SECONDS),
  );

  return c.json({ ok: true });
});

// Tells the UI if fullsend can make the Access applications itself.
setupRoutes.get("/setup/access", requireSetup, async (c) => {
  const settings = await getSettings(c.env);
  const host = settings.api_hostname || new URL(c.req.url).hostname;
  let automatic = false;
  let teamDomain: string | null = null;
  let reason: string | null = null;

  if (!hasToken(c.env)) {
    reason = "CF_API_TOKEN or CF_ACCOUNT_ID is not set.";
  } else {
    try {
      const org = await new Cloudflare(c.env).accessOrganization();
      teamDomain = org.auth_domain;
      automatic = true;
    } catch (err) {
      reason =
        err instanceof CloudflareError
          ? `The token cannot read Zero Trust: ${err.message}. It needs Access: Apps and Policies Edit.`
          : String(err);
    }
  }

  return c.json({
    automatic,
    reason,
    team_domain: teamDomain,
    hostname: host,
    hostname_is_workers_dev: host.endsWith(".workers.dev"),
    public_paths: PUBLIC_PATHS,
  });
});

// Attaches the API hostname, then makes the two Access applications.
setupRoutes.post("/setup/access/auto", requireSetup, async (c) => {
  const body = asRecord(await readJson(c));

  const emails = Array.isArray(body.emails)
    ? body.emails.filter(
        (e): e is string => typeof e === "string" && e.includes("@"),
      )
    : [];

  if (!emails.length) throw validation("Give at least one owner email.");
  const settings = await getSettings(c.env);

  const hostname =
    (isString(body.hostname) && body.hostname.trim().toLowerCase()) ||
    settings.api_hostname;

  if (!hostname || !isHostname(hostname) || hostname.endsWith(".workers.dev")) {
    throw validation(
      "Give a custom hostname for the dashboard and the API, for example `email.example.com`.",
    );
  }

  const cf = new Cloudflare(c.env);
  const steps: { step: string; ok: boolean; detail?: string }[] = [];

  try {
    const zone = await cf.zoneFor(hostname);

    if (!zone)
      throw validation(
        `No active Cloudflare zone in this account holds ${hostname}.`,
      );

    const attached = (await cf.workerDomains(c.env.WORKER_NAME)).some(
      (d) => d.hostname === hostname,
    );

    if (!attached)
      await cf.attachWorkerDomain({
        hostname,
        service: c.env.WORKER_NAME,
        zoneId: zone.id,
      });
    steps.push({ step: "hostname", ok: true, detail: hostname });

    const org = await cf.accessOrganization();
    const apps = await cf.accessApps();

    const existing = (name: string) =>
      apps.find((a) => a.name === name && a.domain === hostname);

    const dashboard =
      existing("fullsend dashboard") ??
      (await cf.createAccessApp({
        name: "fullsend dashboard",
        type: "self_hosted",
        domain: hostname,
        destinations: [{ type: "public", uri: hostname }],
        session_duration: "24h",
        app_launcher_visible: true,
        policies: [
          {
            name: "fullsend owner",
            decision: "allow",
            include: emails.map((email) => ({ email: { email } })),
          },
        ],
      }));

    steps.push({ step: "dashboard_app", ok: true, detail: dashboard.id });

    const api =
      existing("fullsend API") ??
      (await cf.createAccessApp({
        name: "fullsend API",
        type: "self_hosted",
        domain: `${hostname}${PUBLIC_PATHS[0]}`,
        destinations: PUBLIC_PATHS.flatMap((p) => [
          { type: "public", uri: `${hostname}${p}` },
          { type: "public", uri: `${hostname}${p}/*` },
        ]),
        app_launcher_visible: false,
        policies: [
          { name: "public", decision: "bypass", include: [{ everyone: {} }] },
        ],
      }));

    steps.push({ step: "api_app", ok: true, detail: api.id });

    await setSettings(c.env, {
      api_hostname: hostname,
      access_team_domain: org.auth_domain,
      access_aud: dashboard.aud,
      access_app_ids: `${dashboard.id},${api.id}`,
    });
    steps.push({ step: "policy", ok: true, detail: emails.join(", ") });
    deleteCookieSafe(c);

    return c.json({ ok: true, steps, login_url: `https://${hostname}/` });
  } catch (err) {
    if (err instanceof CloudflareError) {
      steps.push({ step: "error", ok: false, detail: err.message });

      return c.json(
        { ok: false, steps, message: `Cloudflare: ${err.message}` },
        422,
      );
    }

    throw err;
  }
});

function deleteCookieSafe(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, SETUP_COOKIE, { path: "/" });
}

// The manual path: the owner made the applications in Zero Trust.
setupRoutes.post("/setup/access/manual", requireSetup, async (c) => {
  const body = asRecord(await readJson(c));

  const team = isString(body.team_domain)
    ? body.team_domain
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
    : "";

  const aud = isString(body.aud) ? body.aud.trim() : "";

  if (!team || !isHostname(team) || !aud)
    throw validation("Give the team domain and the application AUD.");

  const res = await fetch(`https://${team}/cdn-cgi/access/certs`).catch(
    () => null,
  );

  if (!res?.ok)
    throw validation(
      `fullsend cannot read the certificates of ${team}. Check the team domain.`,
    );
  // A JWT in this request proves the AUD at once. Without one, the AUD is
  // checked at the first login.
  const jwt = c.req.header("Cf-Access-Jwt-Assertion");

  if (jwt && !(await verifyAccessJwt(jwt, team, aud))) {
    throw validation(
      "The AUD does not match the Access token of this request.",
    );
  }

  const hostname = isString(body.hostname)
    ? body.hostname.trim().toLowerCase()
    : "";

  if (hostname && !isHostname(hostname))
    throw validation("The `hostname` must be a hostname.");

  const patch: Partial<Settings> = {
    access_team_domain: team,
    access_aud: aud,
  };

  if (hostname) patch.api_hostname = hostname;
  await setSettings(c.env, patch);
  deleteCookieSafe(c);

  return c.json({ ok: true });
});

// Password fallback.
setupRoutes.post("/auth/login", async (c) => {
  const session = await resolveSession(c);

  if (session.mode !== "password")
    return c.json({ error: "not_password_mode" }, 404);

  if (!c.env.SESSION_SECRET) {
    return c.json(
      {
        error: "no_session_secret",
        message: "Set SESSION_SECRET on the Worker to use the password login.",
      },
      500,
    );
  }

  const body = asRecord(await readJson(c));

  if (
    !isString(body.password) ||
    !safeEqual(body.password, c.env.ADMIN_PASSWORD ?? "")
  ) {
    await new Promise((r) => setTimeout(r, 500));

    return c.json(
      { error: "invalid_password", message: "The password is not correct." },
      403,
    );
  }

  setCookie(
    c,
    SESSION_COOKIE,
    await signToken(c.env, "admin", SESSION_TTL),
    cookieOpts(SESSION_TTL),
  );

  return c.json({ ok: true });
});

setupRoutes.on(["GET", "POST"], "/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  return c.req.method === "GET" ? c.redirect("/") : c.json({ ok: true });
});
