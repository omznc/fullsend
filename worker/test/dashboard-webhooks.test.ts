import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createWebhook } from "../src/webhooks/service";
import { call, dashSession } from "./helpers";

let headers: Record<string, string>;

beforeAll(async () => {
  headers = await dashSession();
});

interface Patch {
  endpoint?: string;
  events?: string[];
  secret?: string;
}

const patch = (id: string, body: Patch) =>
  call(`/api/webhooks/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });

describe("dashboard webhook edit", () => {
  it("changes the endpoint and the events, not the secret", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/old",
      events: ["email.sent"],
    });

    const res = await patch(hook.id, {
      endpoint: "https://hooks.example.com/new",
      events: ["email.bounced", "email.delivered"],
      // A secret in the body is ignored.
      secret: "whsec_other",
    });

    expect(res.status).toBe(200);

    const detail = await (
      await call(`/api/webhooks/${hook.id}`, { headers })
    ).json<{
      endpoint: string;
      events: string[];
      signing_secret: string;
      available_events: string[];
    }>();

    expect(detail.endpoint).toBe("https://hooks.example.com/new");
    expect(detail.events).toEqual(["email.bounced", "email.delivered"]);
    expect(detail.signing_secret).toBe(hook.secret);
    expect(detail.available_events).toContain("email.sent");
  });

  it("refuses a bad endpoint and an unknown event", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/keep",
      events: ["email.sent"],
    });

    expect((await patch(hook.id, { endpoint: "ftp://x.example" })).status).toBe(
      422,
    );
    expect((await patch(hook.id, { events: ["email.nope"] })).status).toBe(422);
    expect((await patch(hook.id, { events: [] })).status).toBe(422);

    const after = await (
      await call(`/api/webhooks/${hook.id}`, { headers })
    ).json<{ endpoint: string; events: string[] }>();

    expect(after.endpoint).toBe("https://hooks.example.com/keep");
    expect(after.events).toEqual(["email.sent"]);
  });

  it("needs the dashboard header", async () => {
    const hook = await createWebhook(env, {
      endpoint: "https://hooks.example.com/csrf",
      events: ["email.sent"],
    });

    const res = await call(`/api/webhooks/${hook.id}`, {
      method: "PATCH",
      headers: { Cookie: headers.Cookie! },
      body: JSON.stringify({ endpoint: "https://hooks.example.com/x" }),
    });

    expect(res.status).toBe(400);
  });
});
