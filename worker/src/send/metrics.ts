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
  COUNT(DISTINCT CASE WHEN ev.type = 'sent' THEN ev.email_id END) AS sent,
  COUNT(DISTINCT CASE WHEN ev.type = 'delivered' THEN ev.email_id END) AS delivered,
  COUNT(DISTINCT CASE WHEN ev.type = 'complained' THEN ev.email_id END) AS complained,
  COUNT(DISTINCT CASE WHEN ev.type = 'suppressed' THEN ev.email_id END) AS suppressed,
  COUNT(DISTINCT CASE WHEN ev.type = 'bounced' THEN ev.email_id END) AS bounced,
  COUNT(DISTINCT CASE WHEN ev.type = 'bounced' AND json_extract(ev.data, '$.bounce.type') = 'soft' THEN ev.email_id END) AS bounced_transient,
  COUNT(DISTINCT CASE WHEN ev.type = 'bounced' AND json_extract(ev.data, '$.bounce.type') = 'hard' THEN ev.email_id END) AS bounced_permanent,
  COUNT(DISTINCT CASE WHEN ev.type = 'bounced' AND COALESCE(json_extract(ev.data, '$.bounce.type'), '') NOT IN ('soft', 'hard') THEN ev.email_id END) AS bounced_undetermined,
  COALESCE(SUM(ev.type = 'opened'), 0) AS opened,
  COALESCE(SUM(ev.type = 'clicked'), 0) AS clicked,
  COUNT(DISTINCT CASE WHEN ev.type = 'delivery_delayed' THEN ev.email_id END) AS delivery_delayed,
  COUNT(DISTINCT CASE WHEN ev.type = 'failed' THEN ev.email_id END) AS failed,
  COUNT(DISTINCT CASE WHEN ev.type = 'opened' THEN ev.email_id END) AS unique_opened,
  COUNT(DISTINCT CASE WHEN ev.type = 'clicked' THEN ev.email_id END) AS unique_clicked`;

// The event types that the counts read. The filter lets D1 use the index
// `email_events_type`.
const EVENT_TYPES = [
  "sent",
  "delivered",
  "complained",
  "suppressed",
  "bounced",
  "opened",
  "clicked",
  "delivery_delayed",
  "failed",
];

// A bucket start of the period, in UTC. A bucket of a day or more is a
// date, as in Resend.
const PERIOD: Record<Granularity, string> = {
  hourly:
    "strftime('%Y-%m-%dT%H:00:00.000Z', ev.created_at / 1000, 'unixepoch')",
  daily: "strftime('%Y-%m-%d', ev.created_at / 1000, 'unixepoch')",
  // Weeks start on Monday.
  weekly: "date(ev.created_at / 1000, 'unixepoch', 'weekday 0', '-6 days')",
  monthly: "strftime('%Y-%m-01', ev.created_at / 1000, 'unixepoch')",
};

function isGranularity(value: string): value is Granularity {
  return GRANULARITIES.some((g) => g === value);
}

function isDimension(value: string): value is Dimension {
  return DIMENSIONS.some((d) => d === value);
}

// A list parameter is a comma list, a repeated parameter or both.
const list = (values: string[] | undefined): string[] =>
  (values ?? []).flatMap((v) => v.split(",")).filter(Boolean);

function bad(message: string): ApiError {
  return new ApiError(422, "invalid_parameter", message);
}

// Reads a date or a date and time. A date with no time as `end_date`
// is the last millisecond of that day.
function parseDate(name: string, value: string, endOfDay: boolean): number {
  const at = Date.parse(value);

  if (Number.isNaN(at)) throw bad(`The \`${name}\` must be an ISO 8601 date.`);

  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? at + DAY - 1 : at;
}

// A rate is a percent with one decimal, as in Resend. A rate with no base
// is 0.
const ratio = (part: number, base: number): number =>
  base ? Math.round((part / base) * 1000) / 10 : 0;

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

type Queries = Record<string, string[] | undefined>;

// A scalar parameter takes its first value.
const first = (queries: Queries, name: string): string | undefined =>
  queries[name]?.[0];

function parseRange(queries: Queries, now: number) {
  const endDate = first(queries, "end_date");
  const startDate = first(queries, "start_date");

  // A date in the future counts as now.
  const end = Math.min(
    endDate ? parseDate("end_date", endDate, true) : now,
    now,
  );

  // The default range is the day of `end` and the 6 days before it.
  const start = startDate
    ? parseDate("start_date", startDate, false)
    : Math.floor(end / DAY) * DAY - 6 * DAY;

  if (start > end)
    throw bad("The `start_date` must be on or before `end_date`.");

  return { start, end };
}

function parseGranularity(queries: Queries): Granularity {
  const timezone = first(queries, "timezone");

  if (timezone && timezone.toUpperCase() !== "UTC") {
    throw validation("fullsend gives metrics in UTC only. Use timezone UTC.");
  }

  const granularity = first(queries, "granularity") ?? "daily";

  if (!isGranularity(granularity)) {
    throw bad("The `granularity` must be hourly, daily, weekly or monthly.");
  }

  return granularity;
}

function parseDimensions(queries: Queries): Dimension[] {
  const dimensions: Dimension[] = [];

  for (const d of list(queries.dimensions)) {
    if (d === "broadcast") throw validation("fullsend has no broadcasts.");

    if (!isDimension(d)) {
      throw bad("The `dimensions` must be period, domain or email.");
    }

    if (!dimensions.includes(d)) dimensions.push(d);
  }

  if (list(queries.broadcast_id).length) {
    throw validation("fullsend has no broadcasts.");
  }

  return dimensions;
}

function parseMetrics(queries: Queries): string[] {
  const requested = list(queries.metrics);

  for (const m of requested) {
    if (!METRICS.includes(m) && !UNSUPPORTED.includes(m)) {
      throw bad(`Unknown metric \`${m}\`.`);
    }
  }

  return requested.length
    ? requested.filter((m) => METRICS.includes(m))
    : [...METRICS];
}

// The FROM and WHERE parts of each query, with the bind values.
function buildFilter(
  queries: Queries,
  dimensions: Dimension[],
  range: { start: number; end: number },
) {
  // An ignored email does not count, so the query always joins emails.
  const from = `FROM email_events ev JOIN emails e ON e.id = ev.email_id
    ${dimensions.includes("domain") ? "LEFT JOIN domains d ON d.id = e.domain_id" : ""}`;

  // A flagged open or click came from a bot. The email does not count it.
  const where = [
    `ev.type IN (${EVENT_TYPES.map((t) => `'${t}'`).join(", ")})`,
    "ev.created_at >= ?",
    "ev.created_at <= ?",
    "ev.bot IS NULL",
    "e.ignored_at IS NULL",
  ];

  const binds: (string | number)[] = [range.start, range.end];
  const domainIds = list(queries.domain_id);
  const emailIds = list(queries.email_id);

  if (domainIds.length) {
    where.push("e.domain_id IN (SELECT value FROM json_each(?))");
    binds.push(JSON.stringify(domainIds));
  }

  if (emailIds.length) {
    where.push("ev.email_id IN (SELECT value FROM json_each(?))");
    binds.push(JSON.stringify(emailIds));
  }

  return { from, where: where.join(" AND "), binds };
}

function toRow(r: Record<string, number | string | null>) {
  const counts: Record<string, number> = {};
  const row: Row = {};

  for (const [k, v] of Object.entries(r)) {
    if (isNumber(v) && COUNTS.some((c) => c === k)) counts[k] = v;
    else if (v !== null) row[k] = v;
  }

  return { ...row, ...withRates(counts) };
}

// The SELECT columns and the GROUP BY part for the dimensions.
function groupBy(dimensions: Dimension[], granularity: Granularity) {
  const cols: string[] = [];
  const group: string[] = [];
  const order: string[] = [];

  if (dimensions.includes("period")) {
    cols.push(`${PERIOD[granularity]} AS period`);
    group.push("period");
    order.push("period");
  }

  if (dimensions.includes("domain")) {
    cols.push("e.domain_id AS domain_id", "d.name AS domain_name");
    group.push("e.domain_id");
    order.push("domain_name");
  }

  if (dimensions.includes("email")) {
    cols.push("ev.email_id AS email_id");
    group.push("email_id");
    order.push("email_id");
  }

  return {
    select: `${cols.join(", ")},`,
    group: `GROUP BY ${group.join(", ")} ORDER BY ${order.join(", ")}`,
  };
}

export async function emailMetrics(
  env: Env,
  queries: Queries,
): Promise<Metrics> {
  const range = parseRange(queries, Date.now());
  const granularity = parseGranularity(queries);
  const dimensions = parseDimensions(queries);
  const metrics = parseMetrics(queries);
  const { from, where, binds } = buildFilter(queries, dimensions, range);

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
      `SELECT ${select} ${SQL_COUNTS} ${from} WHERE ${where} ${group} LIMIT ${MAX_ROWS + 1}`,
    )
      .bind(...binds)
      .all<Record<string, number | string | null>>();

    return results.map(toRow);
  };

  const totals = (await run("", ""))[0] ?? withRates({});

  const out: Metrics = {
    object: "metrics",
    start_date: iso(range.start),
    end_date: iso(range.end),
    metrics,
    dimensions,
    granularity,
    totals: pick(totals),
  };

  if (!dimensions.length) return out;

  const grouping = groupBy(dimensions, granularity);
  const rows = await run(grouping.select, grouping.group);

  if (rows.length > MAX_ROWS) {
    throw validation(
      "The answer has too many rows. Use a shorter date range or a filter.",
    );
  }

  out.data = rows.map(pick);

  return out;
}
