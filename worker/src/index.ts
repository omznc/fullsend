import { Hono } from "hono";
import { apiKeysApi } from "./api/api-keys";
import { rememberOrigin } from "./api/auth";
import { domainsApi } from "./api/domains";
import { emailsApi } from "./api/emails";
import { webhooksApi } from "./api/webhooks";
import { runCron } from "./cron";
import {
  accessConfigured,
  authMode,
  type DashVars,
  resolveSession,
} from "./dashboard/auth";
import { dashboardApi } from "./dashboard/index";
import type { Env, HookMessage, SendMessage } from "./env";
import { handleEventsBatch } from "./events/consumer";
import { ApiError, errorResponse } from "./lib/errors";
import { isHostname } from "./lib/http";
import { getSettings, getSettingsCached } from "./lib/settings";
import { handleSendBatch } from "./send/consumer";
import { trackingRoutes } from "./tracking/routes";
import { handleHooksBatch } from "./webhooks/deliver";

export { FullsendRpc } from "./rpc";

const app = new Hono<DashVars>();

app.onError((err, c) => {
  if (err instanceof ApiError) return errorResponse(err);
  console.error("unhandled error", c.req.method, c.req.path, err);

  return errorResponse(
    new ApiError(
      500,
      "application_error",
      "Internal server error. We are unable to process your request right now, please try again later.",
    ),
  );
});

// The tracking hostname serves only the tracking links.
app.use(async (c, next) => {
  const host = new URL(c.req.url).hostname;
  const settings = await getSettingsCached(c.env);

  if (
    settings.tracking_hostname &&
    host === settings.tracking_hostname &&
    !c.req.path.startsWith("/t/")
  ) {
    return c.text("Not found", 404);
  }

  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

app.route("/t", trackingRoutes);

app.route("/emails", emailsApi);

app.route("/domains", domainsApi);

app.route("/api-keys", apiKeysApi);

app.route("/webhooks", webhooksApi);

for (const prefix of ["/emails", "/domains", "/api-keys", "/webhooks"]) {
  app.all(`${prefix}/*`, () => {
    throw new ApiError(
      404,
      "not_found",
      "The requested endpoint does not exist.",
    );
  });
}

app.route("/api", dashboardApi);

// The UI. With Access set up, a request without a valid Access token gets
// nothing: the dashboard fails closed. This also covers the workers.dev
// URL, which Access does not protect.
app.all("*", async (c) => {
  const settings = await getSettings(c.env);

  if (
    authMode(c.env, c.req.url, settings) === "access" &&
    accessConfigured(settings)
  ) {
    const session = await resolveSession(c);

    if (!session.identity) {
      const host = isHostname(settings.api_hostname)
        ? settings.api_hostname
        : null;

      return c.html(
        `<!doctype html><meta charset="utf-8"><title>fullsend</title><body style="font-family:system-ui;margin:4rem auto;max-width:32rem">
<h1>Sign in with Cloudflare Access</h1>
<p>This dashboard is protected by Cloudflare Access.${host ? ` Open <a href="https://${host}/">https://${host}/</a> to sign in.` : ""}</p></body>`,
        403,
      );
    }
  }

  c.executionCtx.waitUntil(rememberOrigin(c.env, new URL(c.req.url).origin));
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(res.headers);
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");

  return new Response(res.body, { status: res.status, headers });
});

// True when the first message body has the field. fullsend puts only
// SendMessage bodies on the send queue and HookMessage bodies on the hooks
// queue, and one batch holds messages of one queue.
function isBatchOf<T>(
  batch: MessageBatch<unknown>,
  field: keyof T & string,
): batch is MessageBatch<T> {
  const first = batch.messages[0]?.body;

  return typeof first === "object" && first !== null && field in first;
}

export default {
  fetch: app.fetch,

  // The deploy form can rename the queues, so the consumer looks at the
  // message body, not at the queue name. One batch holds messages of one
  // queue.
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (isBatchOf<SendMessage>(batch, "emailId")) {
      return handleSendBatch(batch, env);
    }

    if (isBatchOf<HookMessage>(batch, "webhookId")) {
      return handleHooksBatch(batch, env);
    }

    return handleEventsBatch(batch, env);
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runCron(controller, env));
  },
} satisfies ExportedHandler<Env>;
