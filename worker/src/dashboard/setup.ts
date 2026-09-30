import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { Cloudflare, CloudflareError, hasToken } from "../lib/cloudflare";
import { hashPassword, safeEqual, verifyPassword } from "../lib/crypto";
import { validation } from "../lib/errors";
import { asRecord, isHostname, readJson } from "../lib/http";
import { isString } from "../lib/json";
import { setupCode } from "../lib/secrets";
import { getSettings, type Settings, setSettings } from "../lib/settings";
import {
  type DashVars,
  requireSetup,
  resolveSession,
  SESSION_COOKIE,
  SESSION_TTL,
  SETUP_COOKIE,
  SETUP_TTL_SECONDS,
  setupOpen,
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

export const cookieOpts = (maxAge: number) => ({
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

  // The owner reads the setup code in the Worker logs. A SETUP_TOKEN that
  // the owner set is not a secret for fullsend to print.
  if (state === "locked" && !c.env.SETUP_TOKEN)
    console.log(`fullsend setup code: ${await setupCode(c.env)}`);

  return c.json({
    state,
    mode: session.mode,
    identity: session.identity,
    access_configured: session.accessConfigured,
    setup_token_set: Boolean(c.env.SETUP_TOKEN),
    cloudflare_token_set: hasToken(c.env),
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

  if (!setupOpen(settings)) {
    return c.json(
      {
        error: "setup_done",
        message:
          "The login is set up. The setup code no longer opens anything.",
      },
      403,
    );
  }

  const expected = await setupCode(c.env);

  // The generated code is upper case with dashes. Accept it as typed.
  const given = isString(body.token)
    ? c.env.SETUP_TOKEN
      ? body.token.trim()
      : body.token.trim().toUpperCase()
    : "";

  if (!given || !safeEqual(given, expected)) {
    await new Promise((r) => setTimeout(r, 500));

    return c.json(
      { error: "invalid_token", message: "The setup code is not correct." },
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

// Tells if the Worker of this account serves the host of the request: its
// workers.dev URL, or a custom domain that is attached to it.
async function servesHost(
  cf: Cloudflare,
  worker: string,
  host: string,
): Promise<boolean> {
  if (host.endsWith(".workers.dev"))
    return host === `${worker}.${await cf.workersSubdomain()}.workers.dev`;

  return (await cf.workerDomains(worker)).some((d) => d.hostname === host);
}

// Connects a Cloudflare token. The owner pastes it, and fullsend writes it
// and its account ID as Worker secrets. While the setup is open, the token
// is also the proof of ownership: its account must run this Worker at the
// host of the request. Then the request gets the setup cookie.
setupRoutes.post("/setup/token", async (c) => {
  const session = await resolveSession(c);

  if (!session.identity && !setupOpen(await getSettings(c.env)))
    return c.json(
      { error: "unauthorized", message: "Sign in to the dashboard." },
      401,
    );
  const body = asRecord(await readJson(c));
  const token = isString(body.token) ? body.token.trim() : "";

  const accountId = isString(body.account_id)
    ? body.account_id.trim().toLowerCase()
    : "";

  if (!token) throw validation("Paste the Cloudflare token.");

  if (accountId && !/^[0-9a-f]{32}$/.test(accountId))
    throw validation("An account ID has 32 hexadecimal characters.");
  const host = new URL(c.req.url).hostname;

  if (host === "localhost" || host === "127.0.0.1") {
    return c.json(
      {
        error: "local",
        message:
          "A local dev server has no Worker secrets. Put CF_API_TOKEN and CF_ACCOUNT_ID in .dev.vars.",
      },
      422,
    );
  }

  const probe = Cloudflare.forToken(token);
  let ids = accountId ? [accountId] : [];

  if (!ids.length) {
    try {
      ids = (await probe.accounts()).map((a) => a.id);
    } catch (err) {
      if (!(err instanceof CloudflareError)) throw err;
    }
  }

  if (!ids.length) {
    return c.json(
      {
        error: "account_unknown",
        message:
          "Cloudflare did not show the account of this token. Check the token, and give the account ID.",
      },
      422,
    );
  }

  let owner: Cloudflare | null = null;
  let failure: CloudflareError | null = null;

  for (const id of ids) {
    const cf = probe.forAccount(id);

    try {
      if (await servesHost(cf, c.env.WORKER_NAME, host)) {
        owner = cf;
        break;
      }
    } catch (err) {
      if (!(err instanceof CloudflareError)) throw err;
      failure = err;
    }
  }

  if (!owner) {
    return failure
      ? c.json(
          {
            error: "cannot_check",
            message: `Cloudflare refused the check of the Worker: ${failure.message}. Make sure that the token is correct and has Workers Scripts Edit.`,
          },
          422,
        )
      : c.json(
          {
            error: "wrong_account",
            message: `The account of this token does not run the Worker at ${host}. Make the token in the account of this Worker.`,
          },
          403,
        );
  }

  try {
    await owner.putWorkerSecret(
      c.env.WORKER_NAME,
      "CF_ACCOUNT_ID",
      owner.accountId,
    );
    await owner.putWorkerSecret(c.env.WORKER_NAME, "CF_API_TOKEN", token);
  } catch (err) {
    if (!(err instanceof CloudflareError)) throw err;

    return c.json(
      {
        error: "secret_failed",
        message: `Cloudflare did not save the Worker secrets: ${err.message}.`,
      },
      422,
    );
  }

  if (!session.identity) {
    setCookie(
      c,
      SETUP_COOKIE,
      await signToken(c.env, "setup", SETUP_TTL_SECONDS),
      cookieOpts(SETUP_TTL_SECONDS),
    );
  }

  return c.json({ ok: true, account_id: owner.accountId });
});

// The UI asks this until the new Worker version with the secrets serves
// the requests.
setupRoutes.get("/setup/token", requireSetup, (c) =>
  c.json({ token_set: hasToken(c.env) }),
);

const ACCESS_PERMISSION = {
  access: "Access: Apps and Policies Edit",
  access_org: "Access: Organizations, Identity Providers, and Groups Read",
};

// Tells the UI if fullsend can make the Access applications itself.
setupRoutes.get("/setup/access", requireSetup, async (c) => {
  const settings = await getSettings(c.env);
  const host = settings.api_hostname || new URL(c.req.url).hostname;
  let automatic = false;
  let teamDomain: string | null = null;
  let reason: string | null = null;
  // Tells the UI which "how to fix" steps to show. Null for an unknown error.
  let fix: "token_missing" | "token_invalid" | "permissions" | null = null;
  // The permission keys of GET /api/cloudflare that the token does not have.
  const missing: ("access" | "access_org")[] = [];

  if (!hasToken(c.env)) {
    reason = "CF_API_TOKEN or CF_ACCOUNT_ID is not set.";
    fix = "token_missing";
  } else {
    const cf = new Cloudflare(c.env);

    // The team domain needs "Access: Organizations, Identity Providers, and
    // Groups". The apps need "Access: Apps and Policies".
    const [org, apps] = await Promise.allSettled([
      cf.accessOrganization(),
      cf.accessApps(),
    ]);

    if (org.status === "fulfilled" && apps.status === "fulfilled") {
      teamDomain = org.value.auth_domain;
      automatic = true;
    } else {
      const err: unknown = [org, apps].find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      )?.reason;

      if (err instanceof CloudflareError) {
        // Cloudflare gives the same "Authentication error" for a bad token
        // and for a missing permission. A token check tells them apart.
        const valid = await cf.verifyToken().then(
          () => true,
          () => false,
        );

        if (valid) {
          if (org.status === "rejected") missing.push("access_org");

          if (apps.status === "rejected") missing.push("access");
          const names = missing.map((k) => ACCESS_PERMISSION[k]).join(" and ");
          reason = `The token cannot use Zero Trust: ${err.message}. It needs ${names}.`;
          fix = "permissions";
        } else {
          reason = `Cloudflare refused the token: ${err.message}.`;
          fix = "token_invalid";
        }
      } else {
        reason = String(err);
      }
    }
  }

  return c.json({
    automatic,
    reason,
    fix,
    missing,
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

export const MIN_PASSWORD = 12;

// The password login, for an account without Zero Trust. The first setup
// chooses it in place of Access. After this, the setup code opens nothing.
setupRoutes.post("/setup/password", requireSetup, async (c) => {
  const body = asRecord(await readJson(c));

  if (!isString(body.password) || body.password.length < MIN_PASSWORD)
    throw validation(
      `The password must have ${MIN_PASSWORD} characters or more.`,
    );

  const settings = await getSettings(c.env);

  if (!setupOpen(settings))
    return c.json(
      { error: "setup_done", message: "The login is set up." },
      403,
    );

  const hash = await hashPassword(body.password);
  await setSettings(c.env, { auth_mode: "password", password_hash: hash });
  deleteCookieSafe(c);
  setCookie(
    c,
    SESSION_COOKIE,
    await signToken(c.env, "admin", SESSION_TTL, hash),
    cookieOpts(SESSION_TTL),
  );

  return c.json({ ok: true });
});

// The password login.
setupRoutes.post("/auth/login", async (c) => {
  const session = await resolveSession(c);

  if (session.mode !== "password")
    return c.json({ error: "not_password_mode" }, 404);

  const body = asRecord(await readJson(c));
  const { password_hash: hash } = await getSettings(c.env);

  if (
    !isString(body.password) ||
    !(await verifyPassword(body.password, hash))
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
    await signToken(c.env, "admin", SESSION_TTL, hash),
    cookieOpts(SESSION_TTL),
  );

  return c.json({ ok: true });
});

setupRoutes.on(["GET", "POST"], "/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  return c.req.method === "GET" ? c.redirect("/") : c.json({ ok: true });
});
