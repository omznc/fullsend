import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { isJsonObject, parseJsonText } from "../src/lib/json";
import { setSettings } from "../src/lib/settings";
import { POSTHOG_URL, sendTelemetry } from "../src/lib/telemetry";
import { addDomain, call, dashSession } from "./helpers";

// A local .dev.vars can set AUTH_MODE=dev. The tests need it unset.
const prod: Env = { ...env, AUTH_MODE: undefined };

interface Call {
  url: string;
  body: string;
}

function fakeFetch(fail = false): Call[] {
  const calls: Call[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (fail) throw new Error("offline");
    calls.push({ url, body: String(init.body) });

    return new Response("{}");
  });

  return calls;
}

describe("telemetry", () => {
  beforeEach(async () => {
    await setSettings(env, {
      setup_completed: "true",
      telemetry: "true",
      telemetry_counts: "true",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends nothing before the setup is complete", async () => {
    const calls = fakeFetch();
    await setSettings(env, { setup_completed: "false" });
    await sendTelemetry(prod);
    expect(calls).toHaveLength(0);
  });

  it("sends nothing while it is off", async () => {
    const calls = fakeFetch();
    await setSettings(env, { telemetry: "false" });
    await sendTelemetry(prod);
    expect(calls).toHaveLength(0);
  });

  it("sends one ping with counts only", async () => {
    const calls = fakeFetch();
    await addDomain("secret-host.example");
    await setSettings(env, {
      telemetry: "true",
      api_hostname: "mail.private.example",
    });
    await sendTelemetry(prod);
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    const body = parseJsonText(call.body);
    expect(call.url).toBe(POSTHOG_URL);
    expect(isJsonObject(body) && body.event).toBe("instance_ping");
    expect(call.body).toContain('"domains":1');
    expect(call.body).toContain('"errors_24h"');
    expect(call.body).not.toContain("@");
    expect(call.body).not.toContain("private.example");
    expect(call.body).not.toContain("secret-host");
  });

  it("sends only the version while counts are off", async () => {
    const calls = fakeFetch();
    await setSettings(env, { telemetry: "true", telemetry_counts: "false" });
    await sendTelemetry(prod);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain('"version"');
    expect(calls[0]!.body).not.toContain("sent_24h");
    expect(calls[0]!.body).not.toContain("domains");
    expect(calls[0]!.body).not.toContain("auth_mode");
  });

  it("does not throw when the fetch fails", async () => {
    fakeFetch(true);
    await expect(sendTelemetry(prod)).resolves.toBeUndefined();
  });
});

describe("telemetry in the dashboard API", () => {
  it("hides an update from a signed-out caller", async () => {
    const headers = await dashSession();
    await setSettings(env, { latest_version: "99.0.0" });

    const out = await (await call("/api/session")).json<{ update: unknown }>();
    expect(out.update).toBeNull();

    const inn = await (
      await call("/api/session", { headers })
    ).json<{
      update: { latest: string } | null;
    }>();

    expect(inn.update?.latest).toBe("99.0.0");
  });

  it("shows the ping without the API key", async () => {
    const headers = await dashSession();
    await setSettings(env, { setup_completed: "true", telemetry: "true" });

    const on = await (
      await call("/api/settings/telemetry", { headers })
    ).text();

    expect(on).toContain("instance_ping");
    expect(on).not.toContain("api_key");

    await setSettings(env, { telemetry: "false" });

    const off = await (
      await call("/api/settings/telemetry", { headers })
    ).json();

    expect(off).toEqual({ ping: null });
  });
});
