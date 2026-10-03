import { Hono } from "hono";
import {
  createDomain,
  deleteDomain,
  domainJson,
  getDomain,
  listDomainsPage,
  updateDomain,
  verifyDomain,
} from "../domains/service";
import { asRecord, readJson } from "../lib/http";
import { parsePage } from "../lib/page";
import { apiKeyAuth, type ApiVars } from "./auth";

export const domainsApi = new Hono<ApiVars>();

domainsApi.use(apiKeyAuth());

domainsApi.post("/", async (c) => {
  const body = asRecord(await readJson(c));
  const row = await createDomain(c.env, body);
  const { object: _, ...rest } = domainJson(row, true);

  return c.json(rest);
});

domainsApi.get("/", async (c) => {
  const { rows, has_more } = await listDomainsPage(
    c.env,
    parsePage(c.req.query()),
  );

  return c.json({
    object: "list",
    has_more,
    data: rows.map((r) => {
      const { object: _, ...rest } = domainJson(r);

      return rest;
    }),
  });
});

domainsApi.get("/:id", async (c) =>
  c.json(domainJson(await getDomain(c.env, c.req.param("id")), true)),
);

domainsApi.post("/:id/verify", async (c) => {
  const row = await verifyDomain(c.env, c.req.param("id"));

  return c.json({ object: "domain", id: row.id });
});

domainsApi.patch("/:id", async (c) => {
  const body = asRecord(await readJson(c));
  const row = await updateDomain(c.env, c.req.param("id"), body);

  return c.json({ object: "domain", id: row.id });
});

domainsApi.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await deleteDomain(c.env, id);

  return c.json({ object: "domain", id, deleted: true });
});
