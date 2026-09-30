import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { Env } from "../env";
import { hmac, safeEqual, toBase64Url } from "../lib/crypto";
import { getSettings, type Settings } from "../lib/settings";

// Dashboard auth:
// - "access": Cloudflare Access. The default. Without a valid Access JWT,
//   the dashboard fails closed.
// - "password": a password that the owner chose in the first setup, for an
//   account without Zero Trust. D1 stores its hash.
// - "dev": no login, only on localhost, with AUTH_MODE=dev.
export type AuthMode = "access" | "password" | "dev";

export type DashVars = { Bindings: Env; Variables: { identity: string } };

export const SETUP_COOKIE = "fs_setup";

export const SESSION_COOKIE = "fs_session";

const SETUP_TTL = 3600;

export const SESSION_TTL = 7 * 86_400;

export function authMode(env: Env, url: string, s: Settings): AuthMode {
  if (env.AUTH_MODE?.trim().toLowerCase() === "dev") {
    const host = new URL(url).hostname;

    if (host === "localhost" || host === "127.0.0.1") return "dev";
  }

  if (s.auth_mode === "password" && s.password_hash) return "password";

  return "access";
}

// The first setup is open while the owner has chosen no login.
export const setupOpen = (s: Settings) =>
  !accessConfigured(s) && !(s.auth_mode === "password" && s.password_hash);

export const accessConfigured = (s: Settings) =>
  Boolean(s.access_team_domain && s.access_aud);

export type TokenKind = "setup" | "admin";

// A setup token can use SETUP_TOKEN as the key when SESSION_SECRET is not
// set. A session token needs SESSION_SECRET: a person with the setup token
// must not be able to make a session. The key of a session token also holds
// the password hash, so a new password ends all old sessions.
function signingKey(env: Env, kind: TokenKind, bind: string): string | null {
  if (kind === "admin")
    return env.SESSION_SECRET ? `${env.SESSION_SECRET}:${bind}` : null;

  return env.SESSION_SECRET || env.SETUP_TOKEN || null;
}

// A signed value: "<payload>.<expiry>.<mac>".
export async function signToken(
  env: Env,
  kind: TokenKind,
  ttlSeconds: number,
  bind = "",
): Promise<string> {
  const key = signingKey(env, kind, bind);

  if (!key) throw new Error("SESSION_SECRET is not set");
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = `${toBase64Url(new TextEncoder().encode(kind))}.${exp}`;

  return `${body}.${toBase64Url(await hmac(key, body))}`;
}

// Returns true when the token is valid and is of the given kind.
export async function readToken(
  env: Env,
  kind: TokenKind,
  token: string | undefined,
  bind = "",
): Promise<boolean> {
  const key = signingKey(env, kind, bind);

  if (!token || !key) return false;
  const parts = token.split(".");

  const [payload, exp, mac] = parts;

  if (
    parts.length !== 3 ||
    payload === undefined ||
    exp === undefined ||
    mac === undefined
  )
    return false;
  const body = `${payload}.${exp}`;

  if (!safeEqual(toBase64Url(await hmac(key, body)), mac)) return false;

  if (Number(exp) < Date.now() / 1000) return false;

  return payload === toBase64Url(new TextEncoder().encode(kind));
}

// The `email` or the `sub` claim of an Access JWT. A claim that is not a
// string does not name the user.
const identityClaim = z.string();

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<string | null> {
  const issuer = `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  let set = jwks.get(issuer);

  if (!set) {
    set = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwks.set(issuer, set);
  }

  try {
    const { payload } = await jwtVerify(token, set, { issuer, audience: aud });
    const email = identityClaim.safeParse(payload.email);

    if (email.success) return email.data;
    const sub = identityClaim.safeParse(payload.sub);

    return sub.success ? sub.data : "access";
  } catch {
    return null;
  }
}

export interface Session {
  mode: AuthMode;
  accessConfigured: boolean;
  identity: string | null;
  // The owner entered the setup token, and Access is not set up yet.
  setup: boolean;
}

export async function resolveSession(c: Context<DashVars>): Promise<Session> {
  const env = c.env;
  const settings = await getSettings(env);
  const mode = authMode(env, c.req.url, settings);
  const configured = accessConfigured(settings);

  const session: Session = {
    mode,
    accessConfigured: configured,
    identity: null,
    setup: false,
  };

  if (mode === "dev") {
    session.identity = "dev@localhost";

    return session;
  }

  if (mode === "password") {
    session.identity = (await readToken(
      env,
      "admin",
      getCookie(c, SESSION_COOKIE),
      settings.password_hash,
    ))
      ? "admin"
      : null;

    return session;
  }

  if (configured) {
    const jwt =
      c.req.header("Cf-Access-Jwt-Assertion") ??
      getCookie(c, "CF_Authorization");

    if (jwt) {
      session.identity = await verifyAccessJwt(
        jwt,
        settings.access_team_domain,
        settings.access_aud,
      );
    }

    return session;
  }

  if (setupOpen(settings))
    session.setup = await readToken(env, "setup", getCookie(c, SETUP_COOKIE));

  return session;
}

// Allows a request with a dashboard identity.
export const requireIdentity = createMiddleware<DashVars>(async (c, next) => {
  const session = await resolveSession(c);

  if (!session.identity)
    return c.json(
      { error: "unauthorized", message: "Sign in to the dashboard." },
      401,
    );
  c.set("identity", session.identity);
  await next();
});

// Allows a request with a dashboard identity, or with the setup cookie
// while Access is not set up.
export const requireSetup = createMiddleware<DashVars>(async (c, next) => {
  const session = await resolveSession(c);

  if (session.identity) {
    c.set("identity", session.identity);

    return next();
  }

  if (session.setup) {
    c.set("identity", "setup");

    return next();
  }

  return c.json(
    { error: "unauthorized", message: "Enter the setup token first." },
    401,
  );
});

export const SETUP_TTL_SECONDS = SETUP_TTL;
