import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { FullsendRpc } from "../src/rpc";
import { addDomain } from "./helpers";

beforeAll(async () => {
  await addDomain("rpc.example.com");
});

function rpc(caller = "sitegen") {
  // SAFETY: the defineProperty call below sets `props` to `{ caller }`.
  const ctx = createExecutionContext() as ExecutionContext<{ caller: string }>;
  Object.defineProperty(ctx, "props", { value: { caller } });

  return new FullsendRpc(ctx, env);
}

describe("FullsendRpc", () => {
  it("sends with SDK names and tags the caller", async () => {
    const r = rpc();

    const sent = await r.sendEmail({
      from: "a@rpc.example.com",
      to: "x@example.net",
      subject: "rpc",
      text: "t",
      replyTo: "reply@example.com",
      scheduledAt: "in 2 hours",
    });

    expect(sent.error).toBeNull();
    const got = await r.getEmail(sent.data!.id);
    expect(got.data).toMatchObject({
      subject: "rpc",
      reply_to: ["reply@example.com"],
      last_event: "scheduled",
    });

    const row = await env.DB.prepare(
      "SELECT api_key_id FROM emails WHERE id = ?",
    )
      .bind(sent.data!.id)
      .first();

    expect(row).toEqual({ api_key_id: "rpc:sitegen" });

    const canceled = await r.cancelEmail(sent.data!.id);
    expect(canceled.data).toEqual({ object: "email", id: sent.data!.id });
  });

  it("returns Resend errors, not exceptions", async () => {
    const res = await rpc().sendEmail({
      from: "a@nope.example.org",
      to: "x@example.net",
      subject: "s",
      text: "t",
    });

    expect(res).toMatchObject({
      data: null,
      error: { statusCode: 403, name: "validation_error" },
    });
  });
});
