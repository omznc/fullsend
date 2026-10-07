import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, dashSession } from "./helpers";

let headers: Record<string, string>;

beforeAll(async () => {
  headers = await dashSession();

  await env.BODIES.put(
    "emails/att-1.json",
    JSON.stringify({
      html: null,
      text: "t",
      attachments: [
        {
          filename: "page.html",
          content_type: "text/html",
          size: 5,
          content: btoa("<b>x"),
        },
      ],
    }),
  );

  await env.DB.prepare(
    `INSERT INTO emails (id, api_key_id, "from", "to", subject, status, last_event, last_event_at, created_at, body_key)
     VALUES ('att-1', 'k', 'a@x.com', '[]', 's', 'sent', 'sent', 1, 1, 'emails/att-1.json')`,
  ).run();
});

describe("dashboard attachment download", () => {
  it("sends the bytes with the safe headers", async () => {
    const res = await call("/api/emails/att-1/attachments/0", { headers });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<b>x");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });
});
