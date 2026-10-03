import { describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { VERSION } from "../src/version";
import { call } from "./helpers";

describe("version", () => {
  it("equals the version in the root package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("shows the version in /health", async () => {
    const res = await call("/health");

    expect(await res.json()).toEqual({ ok: true, version: VERSION });
  });
});
