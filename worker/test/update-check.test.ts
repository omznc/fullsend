import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSettings, setSettings } from "../src/lib/settings";
import { checkForUpdate, isNewer } from "../src/lib/update-check";

function fakeFetch(response: Response) {
  vi.stubGlobal("fetch", async () => response);
}

describe("isNewer", () => {
  it("compares the numbers", () => {
    expect(isNewer("0.3.0", "0.2.1")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("0.2.1", "0.2.1")).toBe(false);
    expect(isNewer("0.2.0", "0.2.1")).toBe(false);
  });

  it("ignores an empty or invalid version", () => {
    expect(isNewer("", "0.2.1")).toBe(false);
    expect(isNewer("garbage", "0.2.1")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores the version from a good body", async () => {
    fakeFetch(new Response(JSON.stringify({ version: "1.2.3" })));
    await checkForUpdate(env);
    expect((await getSettings(env)).latest_version).toBe("1.2.3");
  });

  it("keeps the old value on an error or a bad body", async () => {
    await setSettings(env, { latest_version: "0.5.0" });
    fakeFetch(
      new Response(JSON.stringify({ version: "9.9.9" }), { status: 500 }),
    );
    await checkForUpdate(env);
    fakeFetch(new Response(JSON.stringify({ version: "latest" })));
    await checkForUpdate(env);
    fakeFetch(new Response("not json"));
    await checkForUpdate(env);
    expect((await getSettings(env)).latest_version).toBe("0.5.0");
  });
});
