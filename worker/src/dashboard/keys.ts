import { Hono } from "hono";
import {
  type ApiKeyRow,
  createKey,
  listKeys,
  revokeKey,
  updateKey,
} from "../keys/service";
import { validation } from "../lib/errors";
import { asRecord, readJson } from "../lib/http";
import { isNumber, isString } from "../lib/json";
import { iso, isoOrNull } from "../lib/time";
import type { DashVars } from "./auth";

export const keyRoutes = new Hono<DashVars>();

export function dashKey(k: ApiKeyRow) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    permission: k.permission,
    domain_id: k.domainId,
    rate_limit: k.rateLimit,
    last_used_at: isoOrNull(k.lastUsedAt),
    created_at: iso(k.createdAt),
  };
}

keyRoutes.get("/", async (c) =>
  c.json({ data: (await listKeys(c.env)).map(dashKey) }),
);

keyRoutes.post("/", async (c) => {
  const body = asRecord(await readJson(c));

  if (!isString(body.name)) throw validation("Missing `name` field.");

  const permission =
    body.permission === "sending_access" ? "sending_access" : "full_access";

  const { token, row } = await createKey(c.env, {
    name: body.name,
    permission,
    domain_id:
      isString(body.domain_id) && body.domain_id ? body.domain_id : null,
    rate_limit: isNumber(body.rate_limit) ? body.rate_limit : null,
  });

  return c.json({ ...dashKey(row), token });
});

// Changes the name or the rate limit of a key. The token stays the same.
keyRoutes.patch("/:id", async (c) => {
  const body = asRecord(await readJson(c));

  if (body.name !== undefined && !isString(body.name)) {
    throw validation("The `name` must be a string.");
  }

  if (body.rate_limit !== undefined && !isNumber(body.rate_limit)) {
    throw validation("The `rate_limit` must be a number.");
  }

  const row = await updateKey(c.env, c.req.param("id"), {
    name: body.name,
    rate_limit: body.rate_limit,
  });

  return c.json(dashKey(row));
});

keyRoutes.delete("/:id", async (c) => {
  await revokeKey(c.env, c.req.param("id"));

  return c.json({ ok: true });
});
