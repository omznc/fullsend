import { Hono } from "hono";
import { createKey, listKeys, revokeKey } from "../keys/service";
import { validation } from "../lib/errors";
import { asRecord, readJson } from "../lib/http";
import { isString } from "../lib/json";
import { iso, isoOrNull } from "../lib/time";
import { apiKeyAuth, type ApiVars } from "./auth";

export const apiKeysApi = new Hono<ApiVars>();

apiKeysApi.use(apiKeyAuth());

apiKeysApi.post("/", async (c) => {
  const body = asRecord(await readJson(c));

  if (!isString(body.name)) throw validation("Missing `name` field.");

  if (
    body.permission !== undefined &&
    body.permission !== "full_access" &&
    body.permission !== "sending_access"
  ) {
    throw validation(
      "The `permission` must be `full_access` or `sending_access`.",
    );
  }

  const { id, token } = await createKey(c.env, {
    name: body.name,
    permission: body.permission,
    domain_id: isString(body.domain_id) ? body.domain_id : null,
  });

  return c.json({ id, token });
});

apiKeysApi.get("/", async (c) => {
  const rows = await listKeys(c.env);

  return c.json({
    object: "list",
    has_more: false,
    data: rows.map((k) => ({
      id: k.id,
      name: k.name,
      created_at: iso(k.createdAt),
      last_used_at: isoOrNull(k.lastUsedAt),
    })),
  });
});

apiKeysApi.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await revokeKey(c.env, id);

  return c.json({ object: "api_key", id, deleted: true });
});
