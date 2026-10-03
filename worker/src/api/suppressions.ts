import { Hono } from "hono";
import { ApiError } from "../lib/errors";
import { asRecord, readJson } from "../lib/http";
import { parsePage } from "../lib/page";
import {
  addressOf,
  addSuppressions,
  checkEmail,
  checkEmails,
  checkIds,
  getSuppression,
  listSuppressions,
  removeSuppressions,
  suppressionId,
  suppressionJson,
} from "../suppressions/service";
import { apiKeyAuth, type ApiVars } from "./auth";

export const suppressionsApi = new Hono<ApiVars>();

suppressionsApi.use(apiKeyAuth());

suppressionsApi.post("/", async (c) => {
  const address = checkEmail(asRecord(await readJson(c)).email);
  await addSuppressions(c.env, [{ address, reason: "manual", source: "api" }]);

  return c.json({ object: "suppression", id: suppressionId(address) });
});

suppressionsApi.get("/", async (c) => {
  const { origin } = c.req.query();

  const { rows, has_more } = await listSuppressions(
    c.env,
    parsePage(c.req.query()),
    origin,
  );

  return c.json({
    object: "list",
    has_more,
    data: rows.map((r) => suppressionJson(r)),
  });
});

suppressionsApi.post("/batch/add", async (c) => {
  const addresses = checkEmails(asRecord(await readJson(c)).emails);

  await addSuppressions(
    c.env,
    addresses.map((address) => ({ address, reason: "manual", source: "api" })),
  );

  return c.json({
    data: addresses.map((a) => ({
      object: "suppression",
      id: suppressionId(a),
    })),
  });
});

suppressionsApi.post("/batch/remove", async (c) => {
  const body = asRecord(await readJson(c));

  if (body.emails !== undefined && body.ids !== undefined) {
    throw new ApiError(
      422,
      "invalid_parameter",
      "Use `emails` or `ids`, not both.",
    );
  }

  // The id of each result is the id that the caller sent, or the id of
  // the address that the caller sent.
  const entries =
    body.ids === undefined
      ? checkEmails(body.emails).map((email) => ({
          id: suppressionId(email),
          address: email,
        }))
      : checkIds(body.ids);

  const removed = new Set(
    (
      await removeSuppressions(c.env, [
        ...new Set(entries.flatMap((e) => e.address ?? [])),
      ])
    ).map((r) => r.address),
  );

  return c.json({
    data: entries.map((e) => ({
      object: "suppression",
      id: e.id,
      deleted: e.address !== null && removed.has(e.address),
    })),
  });
});

suppressionsApi.get("/:idOrEmail", async (c) => {
  const row = await getSuppression(c.env, c.req.param("idOrEmail"));

  return c.json({ object: "suppression", ...suppressionJson(row) });
});

suppressionsApi.delete("/:idOrEmail", async (c) => {
  const idOrEmail = c.req.param("idOrEmail");
  const address = addressOf(idOrEmail);
  const removed = address ? await removeSuppressions(c.env, [address]) : [];

  if (!removed.length)
    throw new ApiError(404, "not_found", "Suppression not found");

  return c.json({
    object: "suppression",
    id: suppressionId(removed[0]!.address),
    deleted: true,
  });
});
