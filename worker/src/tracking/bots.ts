// Flags opens and clicks that look automated, for example the Gmail image
// proxy, Apple Mail Privacy Protection and link scanners. A flagged event
// is kept, but it does not count.

export interface EventContext {
  type: "opened" | "clicked";
  method: string;
  userAgent: string | null;
  asn: number | null;
  // Milliseconds since the email was sent.
  msSinceSent: number | null;
  // Milliseconds since a click on a different link in the same email.
  msSinceOtherClick: number | null;
}

// Networks of mail security scanners that fetch each link or image.
const SCANNER_ASNS = new Map([
  [8075, "Microsoft (Safe Links)"],
  [26211, "Proofpoint"],
  [22843, "Proofpoint"],
  [30031, "Mimecast"],
  [15324, "Barracuda"],
]);

// Apple Mail Privacy Protection loads remote images through Apple's
// proxy for each received email, also when nobody opens it.
const APPLE_ASN = 714;

const BOT_UA =
  /bot|crawl|spider|slurp|preview|scanner|curl|wget|python|go-http|java\/|okhttp|axios|node-fetch|headless|phantomjs|httpclient|libwww|barracuda|mimecast|proofpoint/i;

// Gmail fetches images through its proxy when the message opens, so a
// GoogleImageProxy open is a real open. It is not flagged.

export function botReason(ctx: EventContext): string | null {
  if (ctx.method === "HEAD") return "HEAD request";
  const ua = ctx.userAgent?.trim() ?? "";

  if (!ua) return "no user agent";

  if (!/GoogleImageProxy/i.test(ua) && BOT_UA.test(ua)) return "user agent";

  const scanner = ctx.asn === null ? undefined : SCANNER_ASNS.get(ctx.asn);

  if (scanner) return `scanner network: ${scanner}`;

  if (ctx.type === "opened" && ctx.asn === APPLE_ASN)
    return "Apple Mail Privacy Protection";

  if (ctx.type === "clicked") {
    if (ctx.msSinceSent !== null && ctx.msSinceSent < 5_000)
      return "clicked within 5 s of the send";

    if (ctx.msSinceOtherClick !== null && ctx.msSinceOtherClick < 2_000)
      return "several links clicked within 2 s";
  }

  return null;
}
