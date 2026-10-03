import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createKey, revokeKey } from "../src/keys/service";
import { call, dashSession } from "./helpers";

let headers: Record<string, string>;

beforeAll(async () => {
  headers = await dashSession();
});

interface Patch {
  name?: string;
  rate_limit?: number | string;
}

const patch = (id: string, body: Patch, h = headers) =>
  call(`/api/api-keys/${id}`, {
    method: "PATCH",
    headers: h,
    body: JSON.stringify(body),
  });

interface KeyJson {
  id: string;
  name: string;
  prefix: string;
  permission: string;
  rate_limit: number;
}

describe("dashboard key edit", () => {
  it("renames a key and changes its rate limit", async () => {
    const { id, token } = await createKey(env, {
      name: "before",
      rate_limit: 10,
    });

    const both = await patch(id, { name: "  after  ", rate_limit: 250 });

    expect(both.status).toBe(200);
    expect(await both.json<KeyJson>()).toMatchObject({
      id,
      name: "after",
      rate_limit: 250,
      permission: "full_access",
      prefix: token.slice(0, 10),
    });

    // One field changes only that field.
    const rate = await (await patch(id, { rate_limit: 5 })).json<KeyJson>();

    expect(rate).toMatchObject({ name: "after", rate_limit: 5 });

    const name = await (await patch(id, { name: "last" })).json<KeyJson>();

    expect(name).toMatchObject({ name: "last", rate_limit: 5 });

    // The token still works.
    const res = await call("/emails?limit=1", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).not.toBe(401);
  });

  it("checks the values as the create form does", async () => {
    const { id } = await createKey(env, { name: "checked", rate_limit: 10 });

    for (const rate_limit of [0, 1001, 1.5, -3, "5"]) {
      expect((await patch(id, { rate_limit })).status).toBe(422);
    }

    expect((await patch(id, { name: "" })).status).toBe(422);
    expect((await patch(id, { name: "x".repeat(51) })).status).toBe(422);
    expect((await patch(id, {})).status).toBe(422);

    const list = await (
      await call("/api/api-keys", { headers })
    ).json<{ data: KeyJson[] }>();

    expect(list.data.find((k) => k.id === id)).toMatchObject({
      name: "checked",
      rate_limit: 10,
    });

    expect((await patch(id, { rate_limit: 1000 })).status).toBe(200);
    expect((await patch(id, { rate_limit: 1 })).status).toBe(200);
  });

  it("does not change a revoked or an unknown key", async () => {
    const { id } = await createKey(env, { name: "gone" });
    await revokeKey(env, id);

    expect((await patch(id, { name: "back" })).status).toBe(404);
    expect((await patch("no-such-key", { name: "x" })).status).toBe(404);
  });

  it("needs a session and the dashboard header", async () => {
    const { id } = await createKey(env, { name: "guarded" });

    expect(
      (await patch(id, { name: "x" }, { Cookie: headers.Cookie! })).status,
    ).toBe(400);

    expect(
      (
        await patch(
          id,
          { name: "x" },
          {
            "Content-Type": "application/json",
            "X-Fullsend-Dashboard": "1",
          },
        )
      ).status,
    ).toBe(401);
  });
});
