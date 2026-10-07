import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/lib/json";
import { addDomain, call, newKey } from "./helpers";

interface ErrorBody {
  statusCode: number;
  name: string;
  message: string;
}

async function send(method: string, path: string, body: JsonObject) {
  const { token } = await newKey();

  return call(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("domain fields that fullsend cannot honor", () => {
  it.each([
    ["region", { region: "us-east-1" }],
    ["tls", { tls: "enforced" }],
    ["tls", { tls: "sometimes" }],
    ["custom_return_path", { custom_return_path: "bounce" }],
    ["tracking_subdomain", { tracking_subdomain: "links" }],
    ["capabilities.receiving", { capabilities: { receiving: "enabled" } }],
    ["capabilities.sending", { capabilities: { sending: "disabled" } }],
    ["capabilities", { capabilities: { sending: "enabled", other: "x" } }],
    ["capabilities", { capabilities: "enabled" }],
  ])("refuses %s on create", async (field, extra) => {
    const res = await send("POST", "/domains", {
      name: "new.example.com",
      ...extra,
    });

    expect(res.status).toBe(422);

    const body = await res.json<ErrorBody>();

    expect(body.name).toBe("validation_error");
    expect(body.message).toContain(field);
  });

  it("accepts the values that equal what fullsend does", async () => {
    // The check passes. The test deploy has no Cloudflare token, so the
    // create stops later with the 403 of the SDK test.
    const res = await send("POST", "/domains", {
      name: "new.example.com",
      region: "global",
      tls: "opportunistic",
      custom_return_path: "send",
      capabilities: { sending: "enabled", receiving: "disabled" },
    });

    expect(res.status).toBe(403);
  });

  it("refuses tls and tracking_subdomain on update", async () => {
    const id = await addDomain("update.example.com");

    expect(
      (await send("PATCH", `/domains/${id}`, { tls: "enforced" })).status,
    ).toBe(422);
    expect(
      (await send("PATCH", `/domains/${id}`, { tracking_subdomain: "x" }))
        .status,
    ).toBe(422);
    expect(
      (
        await send("PATCH", `/domains/${id}`, {
          capabilities: { receiving: "enabled" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await send("PATCH", `/domains/${id}`, {
          capabilities: { sending: "enabled" },
          tls: "opportunistic",
          open_tracking: false,
        })
      ).status,
    ).toBe(200);
  });
});
