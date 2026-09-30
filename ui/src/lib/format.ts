// Formats for times, numbers and sizes. Relative times update each
// minute (see useNow). The exact time is always in UTC.

const pad = (n: number) => String(n).padStart(2, "0");

// "2026-09-30 14:27:03 UTC"
export function utc(iso: string | number | Date): string {
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) return "";

  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

// "14:27:03", in UTC.
export function clock(iso: string | number | Date): string {
  const d = new Date(iso);

  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// "3 min ago", "in 2 h", "just now".
export function relative(
  iso: string | number | Date,
  now = Date.now(),
): string {
  const t = new Date(iso).getTime();

  if (Number.isNaN(t)) return "";
  const diff = t - now;
  const abs = Math.abs(diff);
  const future = diff > 0;

  const say = (n: number, unit: string) =>
    future ? `in ${n} ${unit}` : `${n} ${unit} ago`;

  if (abs < 45_000) return future ? "in a moment" : "just now";

  if (abs < 3_600_000) return say(Math.round(abs / 60_000), "min");

  if (abs < 86_400_000) return say(Math.round(abs / 3_600_000), "h");

  if (abs < 30 * 86_400_000) {
    const d = Math.round(abs / 86_400_000);

    return say(d, d === 1 ? "day" : "days");
  }

  return utc(t).slice(0, 10);
}

export const number = (n: number) => n.toLocaleString("en-US");

export function percent(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "-";

  return `${(v * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";

  if (n < 1024) return `${n} B`;

  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;

  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The address part of "Name <a@b.c>".
export function address(v: string): string {
  const m = /<([^>]+)>/.exec(v);

  return (m ? m[1]! : v).trim();
}

// Plain words for a bounce or failure reason from the receiving server.
export function plainReason(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const r = raw.toLowerCase();

  if (/5\.1\.1|does not exist|no such user|user unknown|unknown user/.test(r))
    return "This address does not exist";

  if (/5\.2\.2|mailbox full|quota/.test(r)) return "The mailbox is full";

  if (/spam|blocked|blacklist|block list|policy/.test(r))
    return "The receiving server blocked the email";

  if (/suppress/.test(r)) return "The address is on the suppression list";

  if (/timeout|timed out/.test(r)) return "The receiving server did not reply";

  if (/dns|domain not found|no mx/.test(r))
    return "The domain of the address has no mail server";

  return null;
}
