import type { Env } from "../env";
import { ApiError, validation } from "../lib/errors";
import { isNumber } from "../lib/json";
import { DAY, iso } from "../lib/time";

// GET /emails/metrics. fullsend counts email events in D1. It does not
// have unsubscribes, receiving or broadcasts, so the metrics of these
// leave out of the answer.

const COUNTS = [
  "sent",
  "delivered",
  "complained",
  "suppressed",
  "bounced",
  "bounced_transient",
  "bounced_permanent",
  "bounced_undetermined",
  "opened",
  "clicked",
  "delivery_delayed",
  "failed",
  "unique_opened",
  "unique_clicked",
] as const;

const RATES = [
  "delivery_rate",
  "open_rate",
  "click_rate",
  "bounce_rate",
  "complaint_rate",
] as const;

// The metrics that fullsend can give.
export const METRICS: readonly string[] = [...COUNTS, ...RATES];

// The metrics of the SDK that fullsend does not have.
const UNSUPPORTED = ["received", "unsubscribed", "unsubscribe_rate"];

const DIMENSIONS = ["period", "domain", "email"] as const;

const GRANULARITIES = ["hourly", "daily", "weekly", "monthly"] as const;

type Granularity = (typeof GRANULARITIES)[number];

type Dimension = (typeof DIMENSIONS)[number];

// One response row. A count is a number. The `period` and the domain and
// email fields are text.
type Row = Record<string, number | string | undefined>;

// The most rows in `data`. A wider answer is an error, not a cut list.
const MAX_ROWS = 1000;

const SQL_COUNTS = `
  COALESCE(SUM(ev.type = 'sent'), 0) AS sent,
  COALESCE(SUM(ev.type = 'delivered'), 0) AS delivered,
  COALESCE(SUM(ev.type = 'complained'), 0) AS complained,
  COALESCE(SUM(ev.type = 'suppressed'), 0) AS suppressed,
  COALESCE(SUM(ev.type = 'bounced'), 0) AS bounced,
  COALESCE(SUM(ev.type = 'bounced' AND json_extract(ev.data, '$.bounce.type') = 'soft'), 0) AS bounced_transient,
  COALESCE(SUM(ev.type = 'bounced' AND json_extract(ev.data, '$.bounce.type') = 'hard'), 0) AS bounced_permanent,
  COALESCE(SUM(ev.type = 'bounced' AND COALESCE(json_extract(ev.data, '$.bounce.type'), '') NOT IN ('soft', 'hard')), 0) AS bounced_undetermined,
  COALESCE(SUM(ev.type = 'opened'), 0) AS opened,
  COALESCE(SUM(ev.type = 'clicked'), 0) AS clicked,
  COALESCE(SUM(ev.type = 'delivery_delayed'), 0) AS delivery_delayed,
  COALESCE(SUM(ev.type = 'failed'), 0) AS failed,
  COUNT(DISTINCT CASE WHEN ev.type = 'opened' THEN ev.email_id END) AS unique_opened,
  COUNT(DISTINCT CASE WHEN ev.type = 'clicked' THEN ev.email_id END) AS unique_clicked`;

// A bucket start of the period, in UTC.
const PERIOD: Record<Granularity, string> = {
  hourly:
    "strftime('%Y-%m-%dT%H:00:00.000Z', ev.created_at / 1000, 'unixepoch')",
  daily:
    "strftime('%Y-%m-%dT00:00:00.000Z', ev.created_at / 1000, 'unixepoch')",
  // Weeks start on Monday.
  weekly:
    "strftime('%Y-%m-%dT00:00:00.000Z', date(ev.created_at / 1000, 'unixepoch', 'weekday 0', '-6 days'))",
  monthly:
    "strftime('%Y-%m-01T00:00:00.000Z', ev.created_at / 1000, 'unixepoch')",
};

function isGranularity(value: string): value is Granularity {
  return GRANULARITIES.some((g) => g === value);
}

function isDimension(value: string): value is Dimension {
  return DIMENSIONS.some((d) => d === value);
}

const list = (value: string | undefined): string[] =>
  value ? value.split(",").filter(Boolean) : [];

function bad(message: string): ApiError {
  return new ApiError(422, "invalid_parameter", message);
}

// Reads a date or a date and time. A date with no time as `end_date`
// counts the whole day.
function parseDate(name: string, value: string, endOfDay: boolean): number {
  const at = Date.parse(value);

  if (Number.isNaN(at)) throw bad(`The \`${name}\` must be an ISO 8601 date.`);

  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? at + DAY : at;
}

// A rate is a fraction from 0 to 1. A rate with no base is 0.
const ratio = (part: number, base: number): number =>
  base ? Math.round((part / base) * 10_000) / 10_000 : 0;

function withRates(counts: Record<string, number>) {
  const c = (name: string) => counts[name] ?? 0;

  return {
    ...counts,
    delivery_rate: ratio(c("delivered"), c("sent")),
    open_rate: ratio(c("unique_opened"), c("delivered")),
    click_rate: ratio(c("unique_clicked"), c("delivered")),
    bounce_rate: ratio(c("bounced"), c("sent")),
    complaint_rate: ratio(c("complained"), c("delivered")),
  };
}

export interface Metrics {
  object: "metrics";
  start_date: string;
  end_date: string;
  metrics: string[];
  dimensions: string[];
  granularity: Granularity;
  totals: Row;
  data?: Row[];
}

export async function emailMetrics(
  env: Env,
  query: Record<string, string | undefined>,
): Promise<Metrics> {
  const now = Date.now();

  const end = query.end_date
    ? parseDate("end_date", query.end_date, true)
    : now;

  const start = query.start_date
    ? parseDate("start_date", query.start_date, false)
    : end - 6 * DAY;

  if (start >= end) throw bad("The `start_date` must be before `end_date`.");

  if (query.timezone && query.timezone.toUpperCase() !== "UTC") {
    throw validation("fullsend gives metrics in UTC only. Use timezone UTC.");
  }

  const granularity = query.granularity ?? "daily";

  if (!isGranularity(granularity)) {
    throw bad("The `granularity` must be hourly, daily, weekly or monthly.");
  }

  const dimensions: Dimension[] = [];

  for (const d of list(query.dimensions)) {
    if (d === "broadcast") {
      throw validation("fullsend has no broadcasts.");
    }

    if (!isDimension(d)) {
      throw bad("The `dimensions` must be period, domain or email.");
    }

    if (!dimensions.includes(d)) dimensions.push(d);
  }

  if (query.broadcast_id) throw validation("fullsend has no broadcasts.");

  const requested = list(query.metrics);

  for (const m of requested) {
    if (!METRICS.includes(m) && !UNSUPPORTED.includes(m)) {
      throw bad(`Unknown metric \`${m}\`.`);
    }
  }

  const metrics = requested.length
    ? requested.filter((m) => METRICS.includes(m))
    : [...METRICS];

  const domainIds = list(query.domain_id);
  const emailIds = list(query.email_id);

  // An ignored email does not count, so the query always joins emails.
  const from = `FROM email_events ev JOIN emails e ON e.id = ev.email_id
    ${dimensions.includes("domain") ? "LEFT JOIN domains d ON d.id = e.domain_id" : ""}`;

  // A flagged open or click came from a bot. The email does not count it.
  const where = [
    "ev.created_at >= ?",
    "ev.created_at < ?",
    "ev.bot IS NULL",
    "e.ignored_at IS NULL",
  ];

  const binds: (string | number)[] = [start, end];

  if (domainIds.length) {
    where.push("e.domain_id IN (SELECT value FROM json_each(?))");
    binds.push(JSON.stringify(domainIds));
  }

  if (emailIds.length) {
    where.push("ev.email_id IN (SELECT value FROM json_each(?))");
    binds.push(JSON.stringify(emailIds));
  }

  const pick = (row: Row) => {
    const out: Row = {};

    for (const key of ["period", "domain_id", "domain_name", "email_id"]) {
      if (row[key] !== undefined && row[key] !== null) out[key] = row[key];
    }

    for (const m of metrics) out[m] = row[m];

    return out;
  };

  const run = async (select: string, group: string): Promise<Row[]> => {
    const { results } = await env.DB.prepare(
      `SELECT ${select} ${SQL_COUNTS} ${from} WHERE ${where.join(" AND ")} ${group} LIMIT ${MAX_ROWS + 1}`,
    )
      .bind(...binds)
      .all<Record<string, number | string | null>>();

    return results.map((r) => {
      const counts: Record<string, number> = {};
      const row: Row = {};

      for (const [k, v] of Object.entries(r)) {
        if (isNumber(v) && COUNTS.some((c) => c === k)) counts[k] = v;
        else if (v !== null) row[k] = v;
      }

      return { ...row, ...withRates(counts) };
    });
  };

  const totals = (await run("", ""))[0] ?? withRates({});

  const out: Metrics = {
    object: "metrics",
    start_date: iso(start),
    end_date: iso(end),
    metrics,
    dimensions,
    granularity,
    totals: pick(totals),
  };

  if (dimensions.length) {
    const cols: string[] = [];
    const order: string[] = [];

    if (dimensions.includes("period")) {
      cols.push(`${PERIOD[granularity]} AS period`);
      order.push("period");
    }

    if (dimensions.includes("domain")) {
      cols.push("e.domain_id AS domain_id", "d.name AS domain_name");
      order.push("domain_name");
    }

    if (dimensions.includes("email")) {
      cols.push("ev.email_id AS email_id");
      order.push("email_id");
    }

    const rows = await run(
      `${cols.join(", ")},`,
      `GROUP BY ${order.map((o) => (o === "domain_name" ? "e.domain_id" : o)).join(", ")} ORDER BY ${order.join(", ")}`,
    );

    if (rows.length > MAX_ROWS) {
      throw validation(
        "The answer has too many rows. Use a shorter date range or a filter.",
      );
    }

    out.data = rows.map(pick);
  }

  return out;
}
