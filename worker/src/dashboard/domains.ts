import { Hono } from "hono";
import {
  createDomain,
  deleteDomain,
  type DomainRow,
  ensureSubscription,
  getDomain,
  importDomain,
  listDomains,
  updateDomain,
  verifyDomain,
} from "../domains/service";
import { hasToken } from "../lib/cloudflare";
import { validation } from "../lib/errors";
import { asRecord, readJson } from "../lib/http";
import { iso, isoOrNull } from "../lib/time";
import type { DashVars } from "./auth";

export const domainRoutes = new Hono<DashVars>();

export function dashDomain(d: DomainRow) {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    region: d.region,
    source: d.source,
    open_tracking: d.openTracking,
    click_tracking: d.clickTracking,
    records: d.records,
    cf_zone_id: d.cfZoneId,
    event_subscription: {
      id: d.eventSubscriptionId,
      status: d.eventSubscriptionId
        ? "active"
        : d.eventSubscriptionError
          ? "error"
          : "missing",
      error: d.eventSubscriptionError,
    },
    checked_at: isoOrNull(d.checkedAt),
    created_at: iso(d.createdAt),
  };
}

domainRoutes.get("/", async (c) => {
  const rows = await listDomains(c.env);

  return c.json({ data: rows.map(dashDomain), can_manage: hasToken(c.env) });
});

domainRoutes.post("/", async (c) => {
  const row = await createDomain(c.env, asRecord(await readJson(c)));

  return c.json(dashDomain(row));
});

domainRoutes.post("/import", async (c) => {
  const row = await importDomain(c.env, asRecord(await readJson(c)));

  return c.json(dashDomain(row));
});

domainRoutes.get("/:id", async (c) =>
  c.json(dashDomain(await getDomain(c.env, c.req.param("id")))),
);

domainRoutes.post("/:id/verify", async (c) =>
  c.json(dashDomain(await verifyDomain(c.env, c.req.param("id")))),
);

domainRoutes.patch("/:id", async (c) => {
  const row = await updateDomain(
    c.env,
    c.req.param("id"),
    asRecord(await readJson(c)),
  );

  return c.json(dashDomain(row));
});

// Makes the event subscription again when it is missing.
domainRoutes.post("/:id/subscription", async (c) => {
  const row = await getDomain(c.env, c.req.param("id"));

  const fixed = await ensureSubscription(c.env, {
    ...row,
    eventSubscriptionId: row.eventSubscriptionId,
  });

  return c.json(dashDomain(fixed));
});

domainRoutes.delete("/:id", async (c) => {
  const row = await getDomain(c.env, c.req.param("id"));
  const body = asRecord(await readJson(c));

  if (body.confirm !== row.name)
    throw validation("Type the domain name to confirm.");
  await deleteDomain(c.env, row.id);

  return c.json({ ok: true });
});
