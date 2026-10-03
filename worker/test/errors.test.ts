import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, newKey } from "./helpers";

interface ErrorBody {
  statusCode: number;
  name: string;
  message: string;
}

describe("rate limit", () => {
  it("sets retry-after and the ratelimit headers on a 429", async () => {
    const { token } = await newKey();

    const spy = vi
      .spyOn(env.RATE_LIMITER, "limit")
      .mockResolvedValue({ success: false });

    try {
      const res = await call("/emails", {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(res.headers.get("ratelimit-remaining")).toBe("0");
      expect(Number(res.headers.get("ratelimit-limit"))).toBeGreaterThan(0);
      expect(Number(res.headers.get("ratelimit-reset"))).toBeGreaterThan(0);
      expect((await res.json<ErrorBody>()).name).toBe("rate_limit_exceeded");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("wrong method", () => {
  it("answers 405 for a known path", async () => {
    const res = await call("/emails", { method: "DELETE" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
    expect(await res.json<ErrorBody>()).toMatchObject({
      statusCode: 405,
      name: "method_not_allowed",
    });
  });

  it("matches a path with a parameter", async () => {
    const res = await call("/emails/abc", { method: "PUT" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, PATCH");
  });

  it("covers the health path", async () => {
    const res = await call("/health", { method: "POST" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("keeps 404 for an unknown path", async () => {
    const res = await call("/emails/abc/nothing/here");

    expect(res.status).toBe(404);
    expect((await res.json<ErrorBody>()).name).toBe("not_found");
  });
});
