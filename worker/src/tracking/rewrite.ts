import { signLink } from "./sign";

export interface TrackingOptions {
  origin: string;
  emailId: string;
  open: boolean;
  // The key that signs the links (sessionSecret). Null turns click
  // tracking off.
  clickSecret: string | null;
}

// The scan for `href` stops at `>` and also at the next `<a`. Without the
// stop at `<a`, each `<a` before one `>` scans to that `>` again, and HTML
// with many `<a` and no `>` takes quadratic time. The stop does not change
// the result: a link after the next `<a` matches from that `<a`, and the
// text before it stays the same.
const LINK =
  /(<a\b(?:(?!<a\b)[^>])*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;

export async function addTracking(
  html: string,
  opts: TrackingOptions,
): Promise<string> {
  let out = html;

  if (opts.clickSecret) {
    const secret = opts.clickSecret;
    const matches = [...out.matchAll(LINK)];

    const replacements = await Promise.all(
      matches.map(async (m) => {
        const url = m[3]!.replaceAll("&amp;", "&");
        const sig = await signLink(secret, opts.emailId, url);
        const tracked = `${opts.origin}/t/c/${opts.emailId}?u=${encodeURIComponent(url)}&amp;s=${sig}`;

        return `${m[1]}${m[2]}${tracked}${m[2]}`;
      }),
    );

    let i = 0;
    out = out.replace(LINK, () => replacements[i++]!);
  }

  if (opts.open) {
    const pixel = `<img src="${opts.origin}/t/o/${opts.emailId}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0" />`;
    out = /<\/body>/i.test(out)
      ? out.replace(/<\/body>/i, `${pixel}</body>`)
      : out + pixel;
  }

  return out;
}
