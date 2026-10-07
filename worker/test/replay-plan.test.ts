import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CLAIM_REPLAYS_SQL } from "../src/webhooks/events";

describe("replay claim query plan", () => {
  it("reads the deliveries of one message from the message index", async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${CLAIM_REPLAYS_SQL}`,
    )
      .bind("w", 1, JSON.stringify(["m"]), 0)
      .all<{ detail: string }>();

    const detail = results.map((r) => r.detail).join(" | ");

    expect(detail).toContain("webhook_deliveries_message");
    expect(detail).not.toContain("webhook_deliveries_webhook");
  });
});
