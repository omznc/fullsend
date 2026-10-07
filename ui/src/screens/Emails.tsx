import { type ReactNode, useRef, useState } from "react";
import {
  api,
  type ApiKey,
  type Domain,
  type Email,
  type EmailStatus,
  type List,
  qs,
} from "../api";
import { ReschedulePicker } from "../components/Reschedule";
import {
  Badge,
  Button,
  ButtonLink,
  Checkbox,
  ConfirmDialog,
  cx,
  Dialog,
  EmptyState,
  ErrorState,
  FilterChip,
  Icon,
  Input,
  Select,
  PageHeader,
  Pager,
  RelTime,
  SkeletonBlock,
  Tabs,
  tabPanelProps,
  TableHead,
  TableRow,
  useToast,
} from "../components/ui";
import { plainReason, utc } from "../lib/format";
import {
  useApi,
  useDismiss,
  useNarrow,
  useNow,
  usePoll,
  usePresence,
  useTitle,
} from "../lib/hooks";
import { Link, useQuery } from "../lib/router";

const PAGE = 25;

const STATUSES: EmailStatus[] = [
  "queued",
  "scheduled",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "opened",
  "clicked",
  "failed",
  "canceled",
  "suppressed",
];

// The choices of a time filter. "since" says "last 24 hours" and "until"
// says "24 hours ago".
const SINCE = [
  { since: "last 24 hours", until: "24 hours ago", ms: 86_400_000 },
  { since: "last 7 days", until: "7 days ago", ms: 7 * 86_400_000 },
  { since: "last 30 days", until: "30 days ago", ms: 30 * 86_400_000 },
];

const ALL_COLS =
  "minmax(0,1.2fr) minmax(0,2fr) 170px 130px minmax(0,0.9fr) 140px";

const SCHEDULED_COLS = "minmax(0,1.2fr) minmax(0,2fr) 280px 140px 260px";

const BAD = new Set(["bounced", "failed", "complained"]);

const FILTER_KEYS = [
  "q",
  "status",
  "domain",
  "api_key",
  "tag",
  "since",
  "until",
] as const;

type FilterKey = (typeof FILTER_KEYS)[number];

// The value of each filter in the query string. A missing filter is null.
type Filters = Record<FilterKey, string | null>;

function readFilters(query: URLSearchParams): Filters {
  return {
    q: query.get("q"),
    status: query.get("status"),
    domain: query.get("domain"),
    api_key: query.get("api_key"),
    tag: query.get("tag"),
    since: query.get("since"),
    until: query.get("until"),
  };
}

// The line under a subject: plain words first, then the raw reply.
function reasonLine(e: Email): string | null {
  if (!e.error) return null;
  const plain = plainReason(e.error);

  return plain && plain !== e.error ? `${plain} · ${e.error}` : e.error;
}

const tagText = (t: { name: string; value: string }) =>
  t.value ? `${t.name}:${t.value}` : t.name;

export function Emails() {
  useTitle("Emails");
  const narrow = useNarrow();
  const [query, setQuery] = useQuery();
  const tab = query.get("tab") === "scheduled" ? "scheduled" : "all";
  const after = query.get("after");
  const before = query.get("before");
  const firstPage = !after && !before;

  const filters = readFilters(query);

  const active = FILTER_KEYS.filter((k) => filters[k]);

  // The filters, as the list and the CSV export take them.
  const filterQuery = {
    tab: tab === "scheduled" ? "scheduled" : null,
    status: tab === "all" ? filters.status : null,
    domain: tab === "all" ? filters.domain : null,
    api_key: filters.api_key,
    tag: tab === "all" ? filters.tag : null,
    since: tab === "all" ? filters.since : null,
    until: tab === "all" ? filters.until : null,
    q: filters.q,
  };

  const path = `/emails${qs({ ...filterQuery, limit: PAGE, after, before })}`;

  const { data, error, loading, reload, setData } = useApi<List<Email>>(path);

  const rows = data?.data ?? [];

  // Filter changes go back to the first page.
  const set = (patch: Record<string, string | null>) =>
    setQuery({ after: null, before: null, ...patch });

  const [resetKey, setResetKey] = useState(0);

  const clear = () => {
    set(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])));
    setResetKey((n) => n + 1);
  };

  // The list polls for changes. On the first page, a poll replaces the
  // rows, so new emails show at the top. While the pointer is over the
  // list, new emails wait behind a bar, so rows do not move under the
  // cursor. The rows on screen always get their new status.
  const hovering = useRef(false);

  const [fresh, setFresh] = useState<{ path: string; ids: string[] } | null>(
    null,
  );

  usePoll(
    async () => {
      const polled = path;
      const res = await api<List<Email>>(polled).catch(() => null);

      if (!res) return;

      if (firstPage && !hovering.current) {
        setData(res);
        setFresh(null);

        return;
      }

      const byId = new Map(res.data.map((e) => [e.id, e]));
      setData((prev) =>
        prev
          ? { ...prev, data: prev.data.map((e) => byId.get(e.id) ?? e) }
          : res,
      );

      if (firstPage) setFresh({ path: polled, ids: res.data.map((e) => e.id) });
    },
    data ? 5_000 : null,
  );
  const known = new Set(rows.map((e) => e.id));

  const newCount =
    fresh && fresh.path === path && firstPage
      ? fresh.ids.filter((id) => !known.has(id)).length
      : 0;

  const first = rows[0];
  const last = rows[rows.length - 1];
  const hasNext = before ? true : Boolean(data?.has_more);
  const hasPrev = after ? true : before ? Boolean(data?.has_more) : false;

  let body: ReactNode;

  if (error && !data) {
    body = (
      <ErrorState
        error={error}
        title="Could not load emails"
        onRetry={() => void reload()}
      />
    );
  } else if (!data) {
    body = loading ? <ListSkeleton narrow={narrow} tab={tab} /> : null;
  } else if (rows.length === 0) {
    body = <Empty tab={tab} filtered={active.length > 0} onClear={clear} />;
  } else if (tab === "scheduled") {
    body = (
      <ScheduledTable
        rows={rows}
        narrow={narrow}
        onChanged={() => void reload()}
      />
    );
  } else {
    body = <AllTable rows={rows} narrow={narrow} />;
  }

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        title="Emails"
        subtitle="Every email your apps sent. Click one to see what happened to it."
        actions={
          <>
            <ButtonLink
              href={`/api/emails/export${qs(filterQuery)}`}
              icon="download"
              className="h-10"
            >
              export CSV
            </ButtonLink>
            <ButtonLink
              href="/playground"
              variant="primary"
              icon="mail-arrow-right"
              className="h-10"
            >
              send email
            </ButtonLink>
          </>
        }
      />
      <Tabs
        id="emails"
        value={tab}
        onChange={(t) =>
          setQuery({
            tab: t === "all" ? null : t,
            after: null,
            before: null,
            status: null,
            domain: null,
            tag: null,
            since: null,
            until: null,
          })
        }
        tabs={[
          { value: "all", label: "all" },
          { value: "scheduled", label: "scheduled" },
        ]}
        className="px-1 md:px-5"
      />
      <FilterBar
        key={resetKey}
        tab={tab}
        narrow={narrow}
        filters={filters}
        active={active.length}
        set={set}
        onClear={clear}
      />
      {newCount > 0 && (
        <button
          type="button"
          onClick={() => {
            setFresh(null);
            void reload();
          }}
          className="flex h-10 w-full items-center justify-center gap-2 border-0 border-b border-line bg-raised font-mono text-[12.5px] text-fg hover:bg-hover"
        >
          <Icon name="arrow-up" size={16} />
          {newCount} new {newCount === 1 ? "email" : "emails"}
        </button>
      )}
      <div aria-live="polite" className="sr-only">
        {newCount > 0 ? `${newCount} new emails` : ""}
      </div>
      <div
        {...tabPanelProps("emails", tab)}
        className="contents"
        onPointerEnter={() => {
          hovering.current = true;
        }}
        onPointerLeave={() => {
          hovering.current = false;
        }}
      >
        {body}
      </div>
      {data && rows.length > 0 && (
        <Pager
          hasPrev={hasPrev}
          hasNext={hasNext}
          full
          note={
            tab === "all" ? `newest first · ${PAGE} per page` : "soonest first"
          }
          onPrev={() => first && setQuery({ before: first.id, after: null })}
          onNext={() => last && setQuery({ after: last.id, before: null })}
        />
      )}
    </div>
  );
}

// Filters

function FilterBar({
  tab,
  narrow,
  filters,
  active,
  set,
  onClear,
}: {
  tab: "all" | "scheduled";
  narrow: boolean;
  filters: Filters;
  active: number;
  set: (patch: Record<string, string | null>) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const domains = useApi<{ data: Domain[] }>(tab === "all" ? "/domains" : null);
  const keys = useApi<{ data: ApiKey[] }>("/api-keys");

  const onSearch = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => set({ q: v.trim() || null }), 300);
  };

  const search = (
    <label className="relative flex min-w-0 flex-1 md:w-[320px] md:flex-none">
      <span className="sr-only">Search by recipient or subject</span>
      <Icon
        name="search"
        className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-fg3"
      />
      <Input
        data-list-search
        type="search"
        defaultValue={filters.q ?? ""}
        placeholder={narrow ? "search" : "recipient or subject"}
        onChange={(e) => onSearch(e.target.value)}
        className="h-11 pl-9 md:h-9"
      />
    </label>
  );

  const controls = (
    <>
      {tab === "all" && (
        <StatusFilter
          value={filters.status}
          onChange={(v) => set({ status: v })}
        />
      )}
      {tab === "all" && (
        <Picker
          name="domain"
          value={filters.domain}
          options={(domains.data?.data ?? []).map((d) => [d.id, d.name])}
          onChange={(v) => set({ domain: v })}
        />
      )}
      <Picker
        name="api key"
        value={filters.api_key}
        options={(keys.data?.data ?? []).map((k) => [k.id, k.name])}
        onChange={(v) => set({ api_key: v })}
      />
      {tab === "all" && (
        <TagFilter value={filters.tag} onChange={(v) => set({ tag: v })} />
      )}
      {tab === "all" && (
        <TimeFilter
          name="since"
          value={filters.since}
          onChange={(v) => set({ since: v })}
        />
      )}
      {tab === "all" && (
        <TimeFilter
          name="until"
          value={filters.until}
          onChange={(v) => set({ until: v })}
        />
      )}
      {active > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="h-11 border-0 bg-transparent px-2 font-mono text-[12px] text-fg2 underline underline-offset-3 hover:text-fg md:ml-auto md:h-9"
        >
          clear filters
        </button>
      )}
    </>
  );

  if (narrow)
    return (
      <div className="border-b border-line">
        <div className="flex gap-2 px-4 py-3">
          {search}
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="press flex h-11 items-center gap-1.5 border border-line2 bg-raised px-2.5 font-mono text-[13px] font-medium text-fg"
          >
            <Icon name="sliders" size={16} />
            filters{active > 0 && ` ${active}`}
          </button>
        </div>
        {open && (
          <div className="fs-enter flex flex-wrap items-center gap-1.5 px-4 pb-3">
            {controls}
          </div>
        )}
      </div>
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-8 py-3 font-mono text-[12px]">
      {search}
      {controls}
    </div>
  );
}

const dashed =
  "h-11 md:h-9 border border-dashed border-line2 bg-transparent px-2 font-mono text-[12px] text-fg2 hover:text-fg";

// A dashed select that adds a filter. A set filter shows as a chip.
function Picker({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value?: string | null;
  options: [string, string][];
  onChange: (v: string | null) => void;
}) {
  if (value) {
    const label = options.find(([id]) => id === value)?.[1] ?? value;

    return (
      <FilterChip name={name} value={label} onClear={() => onChange(null)} />
    );
  }

  return (
    <Select
      bare
      chevron={false}
      aria-label={`Add ${name} filter`}
      value=""
      display={
        <>
          <Icon name="plus" size={16} />
          {name}
        </>
      }
      options={options.map(([id, label]) => ({ value: id, label }))}
      onChange={(v) => onChange(v || null)}
      className={cx(dashed, "press flex items-center")}
    />
  );
}

// A time filter. "since" keeps the emails that are newer than the point,
// and "until" keeps the older ones. The choices are a time ago, and the
// chip shows the point in UTC.
function TimeFilter({
  name,
  value,
  onChange,
}: {
  name: "since" | "until";
  value?: string | null;
  onChange: (v: string | null) => void;
}) {
  if (value)
    return (
      <FilterChip
        name={name}
        value={utc(value).slice(0, 16)}
        onClear={() => onChange(null)}
      />
    );

  return (
    <Select
      bare
      chevron={false}
      aria-label={`Add ${name} filter`}
      value=""
      display={
        <>
          <Icon name="plus" size={16} />
          {name}
        </>
      }
      options={SINCE.map((s) => ({ value: s[name], label: s[name] }))}
      onChange={(v) => {
        const p = SINCE.find((s) => s[name] === v);

        if (p) onChange(new Date(Date.now() - p.ms).toISOString());
      }}
      className={cx(dashed, "press flex items-center")}
    />
  );
}

function TagFilter({
  value,
  onChange,
}: {
  value?: string | null;
  onChange: (v: string | null) => void;
}) {
  if (value)
    return (
      <FilterChip name="tag" value={value} onClear={() => onChange(null)} />
    );

  // The same plus icon as the other filters, not a typed "+".
  return (
    <label
      className={cx(
        dashed,
        "flex w-24 cursor-text items-center gap-1.5 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent-fg",
      )}
    >
      <Icon name="plus" size={16} />
      <input
        aria-label="Add tag filter, name or name:value"
        placeholder="tag"
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.currentTarget.value.trim())
            onChange(e.currentTarget.value.trim());
        }}
        onBlur={(e) => {
          if (e.currentTarget.value.trim())
            onChange(e.currentTarget.value.trim());
        }}
        className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[12px] text-fg outline-none placeholder:text-fg2"
      />
    </label>
  );
}

function StatusFilter({
  value,
  onChange,
}: {
  value?: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = usePresence(open);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(box, open, () => setOpen(false));
  const chosen = new Set(value ? value.split(",") : []);

  const toggle = (s: string, on: boolean) => {
    const next = new Set(chosen);

    if (on) next.add(s);
    else next.delete(s);
    onChange(next.size ? STATUSES.filter((x) => next.has(x)).join(",") : null);
  };

  return (
    // A click on a checkbox label moves the focus to no element, so a
    // blur alone does not close the list. A click outside or a Tab out
    // closes it.
    <div
      ref={box}
      className="relative"
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx(
          "press flex h-11 items-center gap-1.5 px-2 font-mono text-[12px] md:h-9",
          value
            ? "border border-line2 bg-raised text-fg"
            : "border border-dashed border-line2 text-fg2 hover:text-fg",
        )}
      >
        {value ? (
          <>
            <span className="text-fg3">status</span>{" "}
            {value.replaceAll(",", ", ")}
          </>
        ) : (
          <>
            <Icon name="plus" size={16} />
            status
          </>
        )}
      </button>
      {value && (
        <button
          type="button"
          aria-label="Clear status"
          onClick={() => onChange(null)}
          className="sr-only focus:not-sr-only"
        >
          clear
        </button>
      )}
      {shown && (
        <div
          data-state={open ? "open" : "closed"}
          className="fs-pop absolute top-full left-0 z-20 mt-1 flex w-56 origin-top-left flex-col gap-1 border border-line2 bg-bg p-3 shadow-[0_10px_30px_var(--shadow)]"
        >
          {STATUSES.map((s) => (
            <Checkbox
              key={s}
              checked={chosen.has(s)}
              onChange={(on) => toggle(s, on)}
            >
              <span className="font-mono text-[12.5px]">{s}</span>
            </Checkbox>
          ))}
        </div>
      )}
    </div>
  );
}

// Tables

function Recipients({ e }: { e: Email }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate font-mono text-[12.5px]">{e.to[0]}</span>
      {e.to.length > 1 && (
        <span className="flex-none bg-raised px-1.25 font-mono text-[11.5px] text-fg2">
          +{e.to.length - 1}
        </span>
      )}
    </span>
  );
}

function Tags({ tags }: { tags: Email["tags"] }) {
  return (
    <>
      {tags.map((t) => (
        <span
          key={tagText(t)}
          className="border border-line2 px-1.5 font-mono text-[11.5px] leading-[18px] text-fg2"
        >
          {tagText(t)}
        </span>
      ))}
    </>
  );
}

function AllTable({ rows, narrow }: { rows: Email[]; narrow: boolean }) {
  return (
    <div>
      {!narrow && (
        <TableHead
          template={ALL_COLS}
          columns={[
            "to",
            "subject",
            "status",
            <span key="l" className="flex items-center text-fg">
              last event
              <Icon name="arrow-down" />
            </span>,
            "tags",
            "api key",
          ]}
        />
      )}
      {rows.map((e) => {
        const reason = reasonLine(e);

        const line = reason && (
          <span
            className={cx(
              "truncate text-[12.5px] leading-[18px]",
              BAD.has(e.status) ? "text-red" : "text-fg2",
            )}
          >
            {reason}
          </span>
        );

        if (narrow)
          return (
            <Link
              key={e.id}
              href={`/emails/${e.id}`}
              className="flex min-h-11 flex-col gap-1 border-b border-line px-4 py-3 text-fg no-underline"
            >
              <span className="flex justify-between gap-3">
                <span className="min-w-0 text-fg2">
                  <Recipients e={e} />
                </span>
                <RelTime at={e.last_event_at} className="flex-none text-fg3" />
              </span>
              <span className="text-[15px] font-medium">{e.subject}</span>
              {reason && (
                <span
                  className={cx(
                    "text-[13px]",
                    BAD.has(e.status) ? "text-red" : "text-fg2",
                  )}
                >
                  {reason}
                </span>
              )}
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                <Badge status={e.status} />
                {e.ignored_at && <Badge status="ignored" hollow />}
                <Tags tags={e.tags} />
                <span className="font-mono text-[12px] text-fg3">
                  {e.api_key.name}
                </span>
              </span>
            </Link>
          );

        return (
          <TableRow
            key={e.id}
            href={`/emails/${e.id}`}
            template={ALL_COLS}
            className="min-h-[52px]"
          >
            <Recipients e={e} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{e.subject}</span>
              {line}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              <Badge status={e.status} />
              {e.ignored_at && <Badge status="ignored" hollow />}
            </span>
            <RelTime at={e.last_event_at} className="text-fg2" />
            <span className="flex flex-wrap gap-1">
              <Tags tags={e.tags} />
            </span>
            <span className="truncate font-mono text-[12px] text-fg2">
              {e.api_key.name}
            </span>
          </TableRow>
        );
      })}
    </div>
  );
}

function ScheduledTable({
  rows,
  narrow,
  onChanged,
}: {
  rows: Email[];
  narrow: boolean;
  onChanged: () => void;
}) {
  const [moving, setMoving] = useState<Email | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const now = useNow();
  const [canceling, setCanceling] = useState<Email | null>(null);
  const toast = useToast();

  return (
    <div>
      {!narrow && (
        <TableHead
          template={SCHEDULED_COLS}
          columns={[
            "to",
            "subject",
            <span key="s" className="flex items-center text-fg">
              sends at
              <Icon name="arrow-up" />
            </span>,
            "api key",
            <span key="a" className="w-full text-right">
              actions
            </span>,
          ]}
        />
      )}
      {rows.map((e) => {
        const actions = (
          <span className="flex justify-end gap-1.5">
            <Button
              icon="calendar"
              className="h-11 md:h-9"
              onClick={() => {
                setMoving(e);
                setMoveOpen(true);
              }}
            >
              reschedule
            </Button>
            <Button
              icon="close"
              variant="danger"
              className="h-11 md:h-9"
              onClick={() => setCanceling(e)}
            >
              cancel
            </Button>
          </span>
        );

        const when = (
          <span className="flex items-center gap-1.5">
            <Icon name="clock" className="text-blue" />
            <span className="flex flex-col leading-[18px]">
              <RelTime at={e.scheduled_at} />
              <span className="font-mono text-[12px] text-fg3">
                {e.scheduled_at ? utc(e.scheduled_at) : "-"}
              </span>
            </span>
          </span>
        );

        return (
          <TableRow
            key={e.id}
            href={`/emails/${e.id}`}
            template={SCHEDULED_COLS}
            className="min-h-[60px]"
          >
            <Recipients e={e} />
            <span className="truncate">{e.subject}</span>
            {when}
            <span className="font-mono text-[12px] text-fg2">
              {e.api_key.name}
            </span>
            {actions}
          </TableRow>
        );
      })}
      <div className="px-4 py-3.5 text-[13px] text-fg3 md:px-8">
        Emails sent with{" "}
        <code className="font-mono text-fg2">scheduled_at</code> wait here.
        Canceled ones move to all with the status canceled.
      </div>
      <Dialog
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        title="Reschedule this email"
        width={340}
      >
        {moving && (
          <ReschedulePicker
            key={moving.id}
            now={now}
            initial={moving.scheduled_at}
            id={moving.id}
            onDone={() => {
              setMoveOpen(false);
              onChanged();
            }}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={canceling !== null}
        title="Cancel this email?"
        body={
          canceling ? `The email "${canceling.subject}" will not be sent.` : ""
        }
        action="cancel email"
        onClose={() => setCanceling(null)}
        onConfirm={async () => {
          if (!canceling) return;
          await api(`/emails/${canceling.id}/cancel`, { method: "POST" });
          toast({ tone: "success", message: "Email canceled." });
          onChanged();
        }}
      />
    </div>
  );
}

// States

function Empty({
  tab,
  filtered,
  onClear,
}: {
  tab: "all" | "scheduled";
  filtered: boolean;
  onClear: () => void;
}) {
  if (filtered)
    return (
      <EmptyState
        icon="mail"
        title="No emails match these filters"
        action={<Button onClick={onClear}>clear filters</Button>}
      >
        Change the filters or clear them to see every email.
      </EmptyState>
    );

  if (tab === "scheduled")
    return (
      <EmptyState icon="clock" title="No scheduled emails">
        Emails sent with <code className="font-mono">scheduled_at</code> wait
        here until they are sent.
      </EmptyState>
    );

  return (
    <EmptyState
      icon="mail"
      title="No emails yet"
      action={
        <div className="flex flex-wrap gap-2">
          <ButtonLink
            href="/playground"
            variant="primary"
            icon="mail-arrow-right"
            className="h-10"
          >
            send a test email
          </ButtonLink>
          <ButtonLink href="/docs" icon="code" className="h-10">
            view snippets
          </ButtonLink>
        </div>
      }
    >
      Send a test email to check your domain and key. Emails your apps send show
      up here within a second.
    </EmptyState>
  );
}

const SKELETON = [
  ["70%", "60%"],
  ["55%", "75%"],
  ["80%", "50%"],
  ["60%", "66%"],
  ["50%", "72%"],
  ["66%", "58%"],
  ["74%", "48%"],
  ["58%", "62%"],
];

function ListSkeleton({
  narrow,
  tab,
}: {
  narrow: boolean;
  tab: "all" | "scheduled";
}) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {SKELETON.map(([a, b], i) =>
        narrow ? (
          <div
            key={i}
            className="flex flex-col gap-2 border-b border-line px-4 py-3"
          >
            <SkeletonBlock className="h-2.5" style={{ width: a }} />
            <SkeletonBlock className="h-3.5" style={{ width: b }} />
            <SkeletonBlock className="h-[22px] w-24" />
          </div>
        ) : (
          <div
            key={i}
            className="grid h-[52px] items-center gap-4 border-b border-line px-8"
            style={{
              gridTemplateColumns: tab === "all" ? ALL_COLS : SCHEDULED_COLS,
            }}
          >
            <SkeletonBlock className="h-2.5" style={{ width: a }} />
            <SkeletonBlock className="h-2.5" style={{ width: b }} />
            <SkeletonBlock className="h-[22px] w-[90px]" />
            <SkeletonBlock className="h-2.5 w-[70px]" />
            {tab === "all" && <SkeletonBlock className="h-5 w-[60px]" />}
            <SkeletonBlock className="h-2.5 w-20" />
          </div>
        ),
      )}
    </div>
  );
}
