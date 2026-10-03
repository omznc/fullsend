import { Hono } from "hono";
import { requireIdentity, type DashVars } from "./auth";
import { domainRoutes } from "./domains";
import { emailRoutes } from "./emails";
import { keyRoutes } from "./keys";
import { logRoutes } from "./logs";
import { miscRoutes } from "./misc";
import { setupRoutes } from "./setup";
import { systemEventRoutes } from "./system-events";
import { webhookRoutes } from "./webhooks";

// The dashboard API under /api. The UI sends `X-Fullsend-Dashboard: 1`
// with each request that changes data. A form on another site cannot set
// this header, so the check blocks cross-site request forgery.
export const dashboardApi = new Hono<DashVars>();

dashboardApi.use(async (c, next) => {
  if (
    c.req.method !== "GET" &&
    c.req.method !== "HEAD" &&
    c.req.header("X-Fullsend-Dashboard") !== "1"
  ) {
    return c.json(
      {
        error: "missing_header",
        message: "Send the X-Fullsend-Dashboard: 1 header.",
      },
      400,
    );
  }

  await next();
});

dashboardApi.route("/", setupRoutes);

const guarded = new Hono<DashVars>();

guarded.use(requireIdentity);

guarded.route("/emails", emailRoutes);

guarded.route("/domains", domainRoutes);

guarded.route("/api-keys", keyRoutes);

guarded.route("/webhooks", webhookRoutes);

guarded.route("/system-events", systemEventRoutes);

guarded.route("/logs", logRoutes);

guarded.route("/", miscRoutes);

guarded.all("*", (c) =>
  c.json({ error: "not_found", message: "No such dashboard endpoint." }, 404),
);

dashboardApi.route("/", guarded);
