import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createKey } from "../src/keys/service";
import type { JsonValue } from "../src/lib/json";
import { call, dashSession } from "./helpers";

let headers: Record<string, string>;

beforeAll(async () => {
  headers = await dashSession();
});

const send = (method: string, path: string, body: JsonValue) =>
  call(`/api${path}`, { method, headers, body: JSON.stringify(body) });

// A dashboard error is { error, message } and never the Resend shape.
async function expectDashError(res: Response, status: number, name: string) {
  expect(res.status).toBe(status);

  const body = await res.json<Record<string, string | number>>();

  expect(Object.keys(body).toSorted()).toEqual(["error", "message"]);
  expect(body.error).toBe(name);
  expect(body.message).toBeTruthy();
}

describe("dashboard error shape", () => {
  it("answers a bad key change with error and message", async () => {
    const { id } = await createKey(env, { name: "shape" });

    await expectDashError(
      await send("PATCH", `/api-keys/${id}`, { name: 5 }),
      422,
      "validation_error",
    );
    await expectDashError(
      await send("PATCH", "/api-keys/no-such-key", { name: "x" }),
      404,
      "not_found",
    );
  });

  it("answers a bad suppression batch with error and message", async () => {
    await expectDashError(
      await send("POST", "/suppressions/batch", { emails: ["not-an-email"] }),
      422,
      "validation_error",
    );
  });

  it("answers a bad setting and a bad purge with error and message", async () => {
    await expectDashError(
      await send("PATCH", "/settings", { request_log: "maybe" }),
      422,
      "validation_error",
    );
    await expectDashError(
      await send("POST", "/settings/purge", { confirm: "no" }),
      422,
      "validation_error",
    );
  });

  it("answers a webhook replay for an unknown webhook with error and message", async () => {
    await expectDashError(
      await send("POST", "/webhooks/no-such-hook/deliveries/resend-failed", {
        since: new Date().toISOString(),
      }),
      404,
      "not_found",
    );
    await expectDashError(
      await send("POST", "/webhooks/no-such-hook/deliveries/resend-failed", {}),
      422,
      "invalid_parameter",
    );
  });

  it("keeps the 500 response of an unexpected error", async () => {
    await env.DB.prepare(
      "ALTER TABLE api_requests RENAME TO api_requests_off",
    ).run();

    try {
      const res = await call("/api/logs", { headers });

      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({
        statusCode: 500,
        name: "internal_server_error",
      });
    } finally {
      await env.DB.prepare(
        "ALTER TABLE api_requests_off RENAME TO api_requests",
      ).run();
    }
  });
});
