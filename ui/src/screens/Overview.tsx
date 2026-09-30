import type { CSSProperties, ReactNode } from "react";
import {
  type Domain,
  type Overview as OverviewData,
  type RateLevel,
  qs,
  type SetupState,
} from "../api";
import {
  Badge,
  ButtonLink,
  cx,
  ErrorState,
  Icon,
  RelTime,
  SkeletonBlock,
  TableRow,
  type Tone,
} from "../components/ui";
import { number, percent, plainReason } from "../lib/format";
import { useApi, useTitle } from "../lib/hooks";
import { Link, useQuery } from "../lib/router";
import { useSession } from "../session";

type Period = OverviewData["period"];

const PERIODS: { value: Period; label: string }[] = [
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
];

// Words for the period, used in the copy under the story.
const WORDS: Record<Period, { previous: string; squares: string }> = {
  "24h": { previous: "the day before", squares: "the last 24 hours'" },
  "7d": { previous: "last week", squares: "this week's" },
  "30d": { previous: "the 30 days before", squares: "the last 30 days'" },
};

const STAT_LABELS = new Map([
  ["sent", "Sent"],
  ["delivered", "Delivered"],
  ["bounced", "Bounced"],
  ["complained", "Marked as spam"],
  ["opened", "Opened"],
  ["clicked", "Clicked"],
]);

const GLOSSARY = [
  {
    t: "bounce",
    d: "The receiving server said no. Hard bounces are permanent.",
  },
  {
    t: "spam report",
    d: "Someone pressed “report spam”. Too many hurt every email.",
  },
  { t: "suppressed", d: "An address fullsend will not email again." },
];

const LEVEL_TONE: Record<Exclude<RateLevel, null>, Tone> = {
  good: "green",
  warning: "amber",
  danger: "red",
};

const LEVEL_LABEL: Record<Exclude<RateLevel, null>, string> = {
  good: "good",
  warning: "watch",
  danger: "danger",
};

const cell = "border-line lg:border-r";

export function Overview() {
  useTitle("Overview");
  const { session } = useSession();
  const [query, setQuery] = useQuery();
  const raw = query.get("period");
  const period: Period = raw === "24h" || raw === "30d" ? raw : "7d";

  const { data, error, loading, reload } = useApi<OverviewData>(
    `/overview${qs({ period })}`,
  );

  if (error && !data)
    return (
      <ErrorState
        error={error}
        title="Could not load the overview"
        onRetry={() => void reload()}
      />
    );

  if (!data) return loading ? <OverviewSkeleton /> : null;

  if (data.total_emails === 0 || !session.setup_completed) return <FirstRun />;

  return (
    <div className="flex flex-1 flex-col">
      <Story
        data={data}
        period={period}
        onPeriod={(p) => setQuery({ period: p === "7d" ? null : p })}
      />
      <StatRow data={data} />
      <section className="grid border-b border-line lg:grid-cols-[minmax(0,1fr)_420px]">
        <div
          className={cx(
            cell,
            "border-b px-4 pt-4.5 pb-5 md:px-8 lg:border-b-0",
          )}
        >
          <Chart data={data} period={period} />
        </div>
        <div className="flex flex-col">
          <RateCard
            label="Bounce rate"
            value={data.bounce_rate.value}
            level={data.bounce_rate.level}
            warn={0.02}
            danger={0.04}
            scale={0.06}
            cols="2fr 2fr 2fr"
            plain="Under 2%, mail providers trust you. Above 4%, they start delaying or rejecting your email."
          />
          <RateCard
            label="Spam report rate"
            value={data.complaint_rate.value}
            level={data.complaint_rate.level}
            warn={0.001}
            danger={0.003}
            scale={0.004}
            cols="1fr 2fr 1fr"
            plain={`Gmail and Yahoo block senders above 0.3%. ${
              data.complaint_rate.level === "danger"
                ? "You are above that."
                : data.complaint_rate.level === "warning"
                  ? "You are getting close."
                  : "You are well below."
            }`}
          />
        </div>
      </section>
      <section className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Failures failures={data.recent_failures} />
        <DomainsColumn domains={data.domains} />
      </section>
    </div>
  );
}

// The sentence, the numbers under it and the waffle.

function Story({
  data,
  period,
  onPeriod,
}: {
  data: OverviewData;
  period: Period;
  onPeriod: (p: Period) => void;
}) {
  const count = (t: string) => data.stats.find((s) => s.type === t);
  const sent = count("sent")?.value ?? 0;
  const delivered = Math.min(count("delivered")?.value ?? 0, sent);
  const bounced = count("bounced")?.value ?? 0;
  const onWay = Math.max(0, sent - delivered - bounced);
  const arrived = sent ? Math.round((delivered / sent) * 100) : 0;
  const spam = Math.round((data.complaint_rate.value ?? 0) * 10_000);
  const words = WORDS[period];

  // Squares of the waffle: 1% each. A bounce always gets one square.
  let red = bounced ? Math.max(1, Math.round((bounced / sent) * 100)) : 0;
  let green = sent ? Math.round((delivered / sent) * 100) : 0;

  if (green + red > 100) green = 100 - red;
  red = Math.min(red, 100);
  const blue = sent ? Math.max(0, 100 - green - red) : 0;

  const squares = [
    ...Array<string>(green).fill("var(--green)"),
    ...Array<string>(blue).fill("var(--blue)"),
    ...Array<string>(red).fill("var(--red)"),
  ];

  while (squares.length < 100) squares.push("var(--raised)");

  const previous = count("sent")?.previous ?? 0;
  const change = previous ? ((sent - previous) / previous) * 100 : null;

  const worst = [data.bounce_rate.level, data.complaint_rate.level].includes(
    "danger",
  )
    ? "danger"
    : [data.bounce_rate.level, data.complaint_rate.level].includes("warning")
      ? "warning"
      : data.bounce_rate.level === null && data.complaint_rate.level === null
        ? null
        : "good";

  const health = {
    good: ["good", "text-green"],
    warning: ["needs a watch", "text-amber"],
    danger: ["at risk", "text-red"],
  } as const;

  const notVerified = data.domains.filter(
    (d) => d.status !== "verified",
  ).length;

  return (
    <section className="grid border-b border-line lg:grid-cols-[minmax(0,1fr)_420px]">
      <div
        className={cx(
          cell,
          "flex flex-col gap-4.5 px-4 pt-6 pb-7 md:px-8 md:pt-8",
        )}
      >
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              aria-pressed={p.value === period}
              onClick={() => onPeriod(p.value)}
              className={cx(
                "h-9 border bg-transparent px-2.5 font-mono text-[12px] font-medium",
                p.value === period
                  ? "border-fg2 text-fg"
                  : "border-line2 text-fg3 hover:text-fg",
              )}
            >
              {p.label}
            </button>
          ))}
          <ButtonLink
            href="/playground"
            variant="primary"
            icon="mail-arrow-right"
            className="ml-1.5"
          >
            send email
          </ButtonLink>
        </div>
        {sent === 0 ? (
          <p className="m-0 max-w-[780px] text-[26px] leading-9 font-medium tracking-[-0.02em] md:text-[34px] md:leading-11">
            You sent no email in this period.{" "}
            <span className="text-fg2">
              Pick a longer period or send a test.
            </span>
          </p>
        ) : (
          <p className="m-0 max-w-[780px] text-[26px] leading-9 font-medium tracking-[-0.02em] text-pretty md:text-[34px] md:leading-11">
            You sent{" "}
            <span className="font-mono font-semibold">{number(sent)}</span>{" "}
            {sent === 1 ? "email" : "emails"}.{" "}
            <span className="text-green">{arrived} of every 100 arrived.</span>{" "}
            <span className="text-fg2">
              {bounced} bounced, and {spam} {spam === 1 ? "person" : "people"}{" "}
              in 10,000 marked you as spam.
            </span>
          </p>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-[12.5px] text-fg2">
          {change !== null && change !== 0 && (
            <span className="flex items-center gap-0.5">
              <Icon
                name={change > 0 ? "arrow-up" : "arrow-down"}
                className={change > 0 ? "text-green" : "text-amber"}
              />
              {Math.abs(change).toFixed(1).replace(/\.0$/, "")}%{" "}
              {change > 0 ? "more" : "less"} than {words.previous}
            </span>
          )}
          {worst && (
            <span className="flex items-center gap-1">
              <Icon name="shield" className={health[worst][1]} />
              sender health {health[worst][0]}
            </span>
          )}
          {notVerified > 0 && (
            <Link
              href="/domains"
              className="flex items-center gap-1.5 text-fg2 no-underline"
            >
              <Icon name="warning-box" size={16} className="text-amber" />
              {notVerified} {notVerified === 1 ? "domain" : "domains"} still
              pending
            </Link>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-3.5 px-4 py-6 md:px-8 md:py-7">
        <Waffle squares={squares} />
        <div className="flex flex-col gap-1 font-mono text-[12.5px]">
          <Legend color="var(--green)" label="arrived" n={delivered} />
          <Legend color="var(--blue)" label="on the way" n={onWay} />
          <Legend color="var(--red)" label="bounced" n={bounced} />
        </div>
        <span className="text-[12.5px] text-fg3">
          Each square is 1% of {words.squares} email.
        </span>
      </div>
    </section>
  );
}

function Waffle({ squares }: { squares: string[] }) {
  return (
    <div aria-hidden className="grid grid-cols-[repeat(20,1fr)] gap-[3px]">
      {squares.map((c, i) => (
        <span key={i} className="aspect-square" style={{ background: c }} />
      ))}
    </div>
  );
}

function Legend({
  color,
  label,
  n,
}: {
  color: string;
  label: string;
  n: number;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="size-2.5" style={{ background: color }} />
      <span className="flex-1">{label}</span>
      {number(n)}
    </span>
  );
}

// The six numbers with the change from the period before.

function StatRow({ data }: { data: OverviewData }) {
  const sent = data.stats.find((s) => s.type === "sent")?.value ?? 0;
  const delivered = data.stats.find((s) => s.type === "delivered")?.value ?? 0;

  return (
    <div className="grid grid-cols-2 border-b border-line md:grid-cols-3 lg:grid-cols-6">
      {data.stats.map((s) => {
        const diff = s.value - s.previous;
        const bad = s.type === "bounced" || s.type === "complained";
        const counted = bad;

        const delta = counted
          ? number(Math.abs(diff))
          : s.previous
            ? `${(Math.abs(diff / s.previous) * 100).toFixed(1).replace(/\.0$/, "")}%`
            : "new";

        const tone =
          diff === 0 || (!bad && s.type !== "delivered")
            ? "text-fg2"
            : diff > 0 === bad
              ? "text-red"
              : "text-green";

        const rate =
          s.type === "sent"
            ? ""
            : s.type === "complained"
              ? percent(delivered ? s.value / delivered : null, 2)
              : percent(
                  sent ? s.value / sent : null,
                  s.type === "bounced" ? 2 : 1,
                );

        return (
          <div
            key={s.type}
            className="flex flex-col gap-0.5 border-r border-b border-line py-3.5 pr-5 pl-4 md:pl-8 lg:border-b-0"
          >
            <span className="text-[13px] text-fg2">
              {STAT_LABELS.get(s.type) ?? s.type}
            </span>
            <span className="font-mono text-[24px] leading-[30px] font-semibold tracking-[-0.03em]">
              {number(s.value)}
            </span>
            <span
              className={cx("flex items-center font-mono text-[12px]", tone)}
            >
              {diff !== 0 && (
                <Icon name={diff > 0 ? "arrow-up" : "arrow-down"} />
              )}
              {diff === 0 ? "no change" : delta}
              <span className="ml-2 text-fg3">{rate}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Stacked bars for each bucket of the series.

const BAR_AREA = 174;

function bucketLabel(at: string, period: Period, i: number): string {
  const d = new Date(at);

  if (period === "7d")
    return d
      .toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })
      .toLowerCase();

  if (period === "30d") return i % 5 === 0 ? at.slice(5, 10) : "";

  return i % 4 === 0 ? `${at.slice(11, 13)}:00` : "";
}

function Chart({ data, period }: { data: OverviewData; period: Period }) {
  const rows = data.series.map((b) => ({
    ...b,
    onWay: Math.max(0, b.sent - b.delivered - b.bounced),
  }));

  const max = Math.max(1, ...rows.map((r) => r.sent));

  const average = rows.length
    ? Math.round(rows.reduce((n, r) => n + r.sent, 0) / rows.length)
    : 0;

  const many = rows.length > 8;
  const gap: CSSProperties = { gap: many ? 3 : 18 };
  const unit = period === "24h" ? "hour" : "day";

  return (
    <>
      <div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-[15px] font-semibold">Emails per {unit}</h2>
        <span className="flex flex-wrap gap-4 font-mono text-[12px] text-fg3">
          <Key color="var(--green)" label="delivered" />
          <Key color="var(--blue)" label="on the way" />
          <Key color="var(--red)" label="bounced" />
          <span className="flex items-center gap-1.5">
            <span className="w-3.5 border-t border-dashed border-fg3" />
            average {number(average)}
          </span>
        </span>
      </div>
      <div
        className="relative grid items-end"
        style={{
          height: BAR_AREA + (many ? 0 : 26),
          gridTemplateColumns: `repeat(${rows.length || 1}, minmax(0, 1fr))`,
          ...gap,
        }}
      >
        <div
          aria-hidden
          className="absolute right-0 left-0 border-t border-dashed border-fg3"
          style={{ bottom: (average / max) * BAR_AREA }}
        />
        {rows.map((r, i) => {
          const last = i === rows.length - 1;

          const seg = (n: number): CSSProperties => ({
            flex: `${n} 1 0`,
            minHeight: n > 0 ? 3 : 0,
          });

          return (
            <div
              key={r.at}
              title={`${r.at.slice(0, 16).replace("T", " ")} UTC: ${number(r.sent)} sent, ${number(r.delivered)} delivered, ${number(r.bounced)} bounced`}
              className="flex h-full flex-col justify-end gap-1.5"
            >
              {!many && (
                <span
                  className={cx(
                    "text-center font-mono text-[12px]",
                    last ? "text-fg" : "text-fg3",
                  )}
                >
                  {number(r.sent)}
                </span>
              )}
              <div
                className="flex flex-col gap-0.5"
                style={{ height: Math.max(2, (r.sent / max) * BAR_AREA) }}
              >
                {r.sent === 0 ? (
                  <span className="flex-1 bg-raised" />
                ) : (
                  <>
                    <span
                      style={{ ...seg(r.bounced), background: "var(--red)" }}
                    />
                    <span
                      style={{ ...seg(r.onWay), background: "var(--blue)" }}
                    />
                    <span
                      style={{
                        ...seg(r.delivered),
                        background: last
                          ? "var(--accent)"
                          : "color-mix(in oklab, var(--green) 75%, transparent)",
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div
        className="mt-2 grid font-mono text-[11.5px] text-fg3"
        style={{
          gridTemplateColumns: `repeat(${rows.length || 1}, minmax(0, 1fr))`,
          ...gap,
        }}
      >
        {rows.map((r, i) => (
          <span
            key={r.at}
            className="overflow-visible text-center whitespace-nowrap"
          >
            {bucketLabel(r.at, period, i)}
          </span>
        ))}
      </div>
    </>
  );
}

function Key({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2.5" style={{ background: color }} />
      {label}
    </span>
  );
}

// A rate with its marker on the good, watch and danger scale.

function RateCard({
  label,
  value,
  level,
  warn,
  danger,
  scale,
  cols,
  plain,
}: {
  label: string;
  value: number | null;
  level: RateLevel;
  warn: number;
  danger: number;
  scale: number;
  cols: string;
  plain: string;
}) {
  const at = value === null ? 0 : Math.min(value / scale, 1) * 100;

  return (
    <div className="flex flex-1 flex-col gap-2 border-t border-b border-line px-4 py-4.5 first:border-t-0 md:px-8 lg:border-t-0">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">{label}</span>
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-[22px] font-semibold">
            {percent(value, 2)}
          </span>
          {level && (
            <Badge
              status="good"
              tone={LEVEL_TONE[level]}
              label={LEVEL_LABEL[level]}
              hollow={false}
            />
          )}
        </span>
      </div>
      <div className="relative" aria-hidden>
        <div className="grid h-2 gap-0.5" style={{ gridTemplateColumns: cols }}>
          <span className="bg-green" />
          <span className="bg-amber opacity-40" />
          <span className="bg-red opacity-40" />
        </div>
        {value !== null && (
          <span
            className="absolute -top-1 h-4 w-[3px] bg-fg"
            style={{ left: `${at}%` }}
          />
        )}
      </div>
      <div
        className="grid gap-0.5 font-mono text-[11px] text-fg3"
        style={{ gridTemplateColumns: cols }}
      >
        <span>good</span>
        <span>watch {percent(warn, 1)}</span>
        <span>danger {percent(danger, 1)}</span>
      </div>
      <span className="text-[13px] text-fg2">
        {value === null ? "No email yet to measure." : plain}
      </span>
    </div>
  );
}

// Recent failures and domains.

const FAIL_COLS = "90px 150px minmax(0,210px) minmax(0,1fr)";

function Failures({ failures }: { failures: OverviewData["recent_failures"] }) {
  return (
    <div className="border-line lg:border-r">
      <div className="flex items-center justify-between border-b border-line px-4 py-3.5 md:px-8">
        <h2 className="m-0 text-[15px] font-semibold">Recent failures</h2>
        <Link
          href="/emails?status=bounced,failed,complained"
          className="flex items-center gap-1.5 font-mono text-[12px] text-fg2 no-underline"
        >
          all failed emails
          <Icon name="chevron-right" size={16} />
        </Link>
      </div>
      {failures.length === 0 && (
        <div className="flex items-center gap-2.5 px-4 py-6 text-fg2 md:px-8">
          <Icon name="check" className="text-green" />
          No failed emails. Bounces and spam reports show up here.
        </div>
      )}
      {failures.map((f) => {
        const reason =
          f.status === "complained"
            ? `Reported "${f.subject}" as spam`
            : (plainReason(f.reason) ?? f.reason ?? f.subject);

        return (
          <TableRow key={f.id} href={`/emails/${f.id}`} template={FAIL_COLS}>
            <RelTime at={f.at} className="text-fg3" />
            <span>
              <Badge status={f.status} />
            </span>
            <span className="truncate font-mono text-[12.5px]">
              {f.to[0]}
              {f.to.length > 1 && (
                <span className="ml-1.5 bg-raised px-1 text-[11.5px] text-fg2">
                  +{f.to.length - 1}
                </span>
              )}
            </span>
            <span className="truncate text-[13px] text-fg2">{reason}</span>
          </TableRow>
        );
      })}
    </div>
  );
}

function domainNote(d: Domain): ReactNode {
  if (d.status !== "verified") {
    const open = d.records.filter((r) => r.status !== "verified").length;

    return open
      ? `${open} DNS ${open === 1 ? "record is" : "records are"} not verified yet. Email from here is not sent yet.`
      : "This domain is not verified yet. Email from here is not sent yet.";
  }

  if (d.event_subscription.status !== "active")
    return "Delivery events are not connected. Statuses may not update.";

  return null;
}

function DomainsColumn({ domains }: { domains: Domain[] }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-y border-line px-4 py-3.5 md:px-8 lg:border-t-0">
        <h2 className="m-0 text-[15px] font-semibold">Domains</h2>
        <Link
          href="/domains"
          className="flex items-center gap-1.5 font-mono text-[12px] text-fg2 no-underline"
        >
          <Icon name="plus" size={16} />
          add
        </Link>
      </div>
      {domains.length === 0 && (
        <div className="border-b border-line px-4 py-4 text-fg2 md:px-8">
          No domains yet. Add one to send email.
        </div>
      )}
      {domains.map((d) => {
        const note = domainNote(d);

        return (
          <Link
            key={d.id}
            href={`/domains/${d.id}`}
            className="flex flex-col gap-1.5 border-b border-line px-4 py-3 text-fg no-underline hover:bg-hover md:px-8"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[13px] font-semibold">
                {d.name}
              </span>
              <Badge status={d.status} />
            </span>
            <span className="flex gap-3.5 font-mono text-[12px] text-fg2">
              <Tracking on={d.open_tracking} label="open tracking" />
              <Tracking on={d.click_tracking} label="click tracking" />
            </span>
            {note && <span className="text-[12.5px] text-amber">{note}</span>}
          </Link>
        );
      })}
      <div className="flex flex-1 flex-col gap-3 bg-panel px-4 py-4 md:px-8">
        <span className="mb-1 block text-[14px] font-semibold">
          Words you will see
        </span>
        {GLOSSARY.map((g) => (
          <span key={g.t} className="flex flex-col gap-0.5">
            <span className="font-mono text-[12.5px] font-semibold">{g.t}</span>
            <span className="text-[13px] leading-[19px] text-fg2">{g.d}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Tracking({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="flex items-center gap-0.5">
      <Icon
        name={on ? "toggle-right" : "toggle-left"}
        className={on ? "text-accent-fg" : "text-fg3"}
      />
      {label}
      <span className="sr-only">{on ? " is on" : " is off"}</span>
    </span>
  );
}

// First run: a checklist from the setup state.

function FirstRun() {
  const { data, error, reload } = useApi<SetupState>("/setup/state");
  const verified = data?.domains.find((d) => d.status === "verified");

  const steps = data
    ? [
        {
          done: data.cloudflare_token_set,
          label: "Cloudflare token connected",
          meta: "",
          step: 1,
        },
        {
          done: Boolean(verified),
          label: verified ? `${verified.name} verified` : "Domain verified",
          meta: verified ? `${verified.records.length} records` : "",
          step: 2,
        },
        {
          done: Boolean(data.api_hostname && data.tracking_hostname),
          label: "Hostnames attached",
          meta: data.tracking_hostname
            ? (data.api_hostname ?? "")
            : data.api_hostname
              ? "no tracking hostname"
              : "",
          step: 5,
        },
        {
          done: data.api_keys > 0,
          label: "First API key",
          meta: data.api_keys > 0 ? `${data.api_keys} active` : "",
          step: 6,
        },
        {
          done: data.emails > 0,
          label: "Test email",
          meta: data.emails > 0 ? `${number(data.emails)} sent` : "",
          step: 7,
        },
      ]
    : [];

  return (
    <section className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className={cx(cell, "flex flex-col gap-4 pt-8 pb-8 md:pt-12")}>
        <p className="m-0 max-w-[760px] px-4 text-[26px] leading-9 font-medium tracking-[-0.02em] md:px-8 md:text-[34px] md:leading-11">
          Your story starts with one email.{" "}
          <span className="text-fg2">
            Finish setup and send a test to see it arrive.
          </span>
        </p>
        <div className="border-t border-line">
          {error && !data ? (
            <ErrorState
              error={error}
              title="Could not load the setup steps"
              onRetry={() => void reload()}
            />
          ) : !data ? (
            Array.from({ length: 5 }, (_, i) => (
              <div
                key={i}
                className="flex min-h-12 items-center border-b border-line px-4 md:px-8"
              >
                <SkeletonBlock className="h-2.5 w-[40%]" />
              </div>
            ))
          ) : (
            <ul className="m-0 list-none p-0">
              {steps.map((s) => (
                <li
                  key={s.label}
                  className="flex min-h-12 items-center gap-2.5 border-b border-line px-4 md:px-8"
                >
                  <Icon
                    name={s.done ? "check" : "checkbox-on"}
                    className={s.done ? "text-green" : "text-fg3"}
                  />
                  <span
                    className={cx("flex-1", s.done ? "text-fg" : "text-fg2")}
                  >
                    {s.label}
                    <span className="sr-only">
                      {s.done ? ", done" : ", not done"}
                    </span>
                  </span>
                  {s.meta && (
                    <span className="font-mono text-[12px] text-fg3">
                      {s.meta}
                    </span>
                  )}
                  {!s.done && (
                    <Link
                      href={`/setup/${s.step}`}
                      className="flex items-center gap-0.5 font-mono text-[12px] text-fg2 underline underline-offset-3 hover:text-fg"
                    >
                      set up
                      <Icon name="chevron-right" size={16} />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap gap-2 px-4 md:px-8">
          <SetupLink />
          <ButtonLink href="/playground" icon="code" className="h-10">
            open playground
          </ButtonLink>
        </div>
      </div>
      <div className="flex flex-col gap-3.5 px-4 py-6 md:px-8 md:py-7">
        <Waffle squares={Array<string>(100).fill("var(--raised)")} />
        <span className="text-[12.5px] text-fg3">
          These squares fill in as email is sent. Each is 1% of the period.
        </span>
      </div>
    </section>
  );
}

function SetupLink() {
  return (
    <Link
      href="/setup"
      className="inline-flex h-10 items-center gap-1.5 bg-accent pr-2.5 pl-3.5 font-mono text-[12.5px] font-semibold whitespace-nowrap text-accent-ink no-underline hover:text-accent-ink"
    >
      continue setup
      <Icon name="chevron-right" size={16} />
    </Link>
  );
}

function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col">
      <section className="grid border-b border-line lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-4 px-4 py-8 md:px-8">
          <SkeletonBlock className="h-11 w-[80%]" />
          <SkeletonBlock className="h-11 w-[55%]" />
          <SkeletonBlock className="h-3 w-[40%]" />
        </div>
        <div className="px-4 py-7 md:px-8">
          <div className="grid grid-cols-[repeat(20,1fr)] gap-[3px]">
            {Array.from({ length: 100 }, (_, i) => (
              <SkeletonBlock key={i} className="aspect-square" />
            ))}
          </div>
        </div>
      </section>
      <div className="grid grid-cols-2 border-b border-line md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 py-4 pl-4 md:pl-8">
            <SkeletonBlock className="h-3 w-16" />
            <SkeletonBlock className="h-6 w-20" />
          </div>
        ))}
      </div>
      <SkeletonBlock className="mx-4 my-5 h-[200px] md:mx-8" />
    </div>
  );
}
