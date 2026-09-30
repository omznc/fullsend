import { Hono } from "hono";
import type { Env } from "../env";
import { recordEvent } from "../events/record";
import { parseAddressColumn } from "../send/consumer";
import { botReason } from "./bots";
import { checkLink } from "./sign";

export const trackingRoutes = new Hono<{ Bindings: Env }>();

// A transparent 1x1 GIF.
const PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (ch) => ch.charCodeAt(0),
);

interface TrackedEmail {
  id: string;
  to: string;
  sent_at: number | null;
}

async function loadEmail(env: Env, id: string): Promise<TrackedEmail | null> {
  return env.DB.prepare('SELECT id, "to", sent_at FROM emails WHERE id = ?')
    .bind(id)
    .first<TrackedEmail>();
}

// The recipient, when the email has only one.
function soleRecipient(email: TrackedEmail): string | null {
  const to = parseAddressColumn(email.to);

  return to.length === 1 ? to[0]! : null;
}

function hasAsn(
  cf: CfProperties | undefined,
): cf is IncomingRequestCfProperties & { asn: number } {
  return cf !== undefined && "asn" in cf && typeof cf.asn === "number";
}

function asn(req: Request): number | null {
  return hasAsn(req.cf) ? req.cf.asn : null;
}

trackingRoutes.on(["GET", "HEAD"], "/o/:id", async (c) => {
  const id = c.req.param("id").replace(/\.(gif|png)$/, "");
  c.executionCtx.waitUntil(
    (async () => {
      const email = await loadEmail(c.env, id);

      if (!email) return;

      const bot = botReason({
        type: "opened",
        method: c.req.method,
        userAgent: c.req.header("User-Agent") ?? null,
        asn: asn(c.req.raw),
        msSinceSent: email.sent_at ? Date.now() - email.sent_at : null,
        msSinceOtherClick: null,
      });

      await recordEvent(c.env, email.id, {
        type: "opened",
        recipient: soleRecipient(email),
        bot,
        data: {
          user_agent: c.req.header("User-Agent") ?? null,
          ip: c.req.header("CF-Connecting-IP") ?? null,
        },
      });
    })().catch((err) => console.error("open tracking", err)),
  );

  return new Response(PIXEL, {
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
    },
  });
});

trackingRoutes.on(["GET", "HEAD"], "/c/:id", async (c) => {
  const id = c.req.param("id");
  const url = c.req.query("u");
  const sig = c.req.query("s");
  const secret = c.env.SESSION_SECRET;

  if (!url || !sig || !secret || !(await checkLink(secret, id, url, sig))) {
    return c.text("This link is not valid.", 400);
  }

  c.executionCtx.waitUntil(
    (async () => {
      const email = await loadEmail(c.env, id);

      if (!email) return;

      const other = await c.env.DB.prepare(
        "SELECT created_at FROM email_events WHERE email_id = ? AND type = 'clicked' AND json_extract(data, '$.link') != ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(id, url)
        .first<{ created_at: number }>();

      const bot = botReason({
        type: "clicked",
        method: c.req.method,
        userAgent: c.req.header("User-Agent") ?? null,
        asn: asn(c.req.raw),
        msSinceSent: email.sent_at ? Date.now() - email.sent_at : null,
        msSinceOtherClick: other ? Date.now() - other.created_at : null,
      });

      await recordEvent(c.env, email.id, {
        type: "clicked",
        recipient: soleRecipient(email),
        bot,
        data: {
          link: url,
          user_agent: c.req.header("User-Agent") ?? null,
          ip: c.req.header("CF-Connecting-IP") ?? null,
        },
      });
    })().catch((err) => console.error("click tracking", err)),
  );

  return c.redirect(url, 302);
});
