import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";
import { apiKeys } from "../db/schema";
import type { Env } from "../env";
import {
  type ApiKeyRow,
  checkRateLimit,
  findKeyByToken,
} from "../keys/service";
import { ApiError } from "../lib/errors";
import { getSetting, setSettings } from "../lib/settings";

export type ApiVars = { Variables: { apiKey: ApiKeyRow }; Bindings: Env };

// Checks the API key. With `sendOnly`, a sending key may use the route.
export const apiKeyAuth = (opts: { sendOnly?: boolean } = {}) =>
  createMiddleware<ApiVars>(async (c, next) => {
    const header = c.req.header("Authorization");

    if (!header) {
      throw new ApiError(
        401,
        "missing_api_key",
        "Missing API key in the authorization header. Include the following header in the request: Authorization: Bearer YOUR_API_KEY",
      );
    }

    const token = header.replace(/^Bearer\s+/i, "").trim();
    const key = token ? await findKeyByToken(c.env, token) : null;

    if (!key || key.revokedAt) {
      throw new ApiError(403, "invalid_api_key", "API key is invalid");
    }

    if (key.permission === "sending_access" && !opts.sendOnly) {
      throw new ApiError(
        401,
        "restricted_api_key",
        "This API key is restricted to only send emails",
      );
    }

    await checkRateLimit(c.env, key);
    c.set("apiKey", key);

    const now = Date.now();

    if (!key.lastUsedAt || now - key.lastUsedAt > 60_000) {
      c.executionCtx.waitUntil(
        getDb(c.env)
          .update(apiKeys)
          .set({ lastUsedAt: now })
          .where(eq(apiKeys.id, key.id)),
      );
    }

    c.executionCtx.waitUntil(rememberOrigin(c.env, new URL(c.req.url).origin));
    await next();
  });

let originKnown = false;

// Stores the first origin that fullsend sees, as a fallback for links.
export async function rememberOrigin(env: Env, origin: string): Promise<void> {
  if (originKnown) return;

  if (origin.startsWith("http://localhost") || origin.includes("127.0.0.1")) {
    return;
  }

  if (!(await getSetting(env, "public_url"))) {
    await setSettings(env, { public_url: origin });
  }

  originKnown = true;
}
