import { type ReactNode, useRef } from "react";
import { type ApiKey, type RequestLog, type RequestLogPage, qs } from "../api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  PageHeader,
  Pager,
  RelTime,
  Select,
  SidePanel,
  Skeleton,
  TableHead,
  TableRow,
  TextLink,
  type Tone,
} from "../components/ui";
import { duration, utc } from "../lib/format";
import { useApi, useNarrow, useTitle } from "../lib/hooks";
import { useQuery } from "../lib/router";

const PAGE = 25;

const COLS = "100px 70px minmax(0,1fr) 80px 150px 80px 190px";

const HEAD = [
  "time",
  "method",
  "path",
  "status",
  "api key",
  "time taken",
  "error",
];

const STATUSES = [
  { value: "", label: "all statuses" },
  { value: "2xx", label: "2xx success" },
  { value: "4xx", label: "4xx client error" },
  { value: "5xx", label: "5xx server error" },
];

const METHODS = [
  { value: "", label: "all methods" },
  ...["GET", "POST", "PATCH", "PUT", "DELETE"].map((m) => ({
    value: m,
    label: m,
  })),
];

const FILTER_KEYS = ["status", "method", "key", "q"] as const;

function statusTone(status: number): Tone {
  if (status >= 500) return "red";

  if (status >= 400) return "amber";

  if (status >= 300) return "blue";

  return "green";
}

function StatusBadge({ status }: { status: number }) {
  return (
    <Badge
      status={String(status)}
      label={String(status)}
      tone={statusTone(status)}
    />
  );
}

// The request log: each call to a Resend API route, newest first.
export function Logs() {
  useTitle("Logs");
  const narrow = useNarrow();
  const [query, setQuery] = useQuery();
  const after = query.get("after");
  const before = query.get("before");
  const selected = query.get("log");

  const filters = {
    status: query.get("status"),
    method: query.get("method"),
    key: query.get("key"),
    q: query.get("q"),
  };

  const active = FILTER_KEYS.filter((k) => filters[k]).length;

  const path = `/logs${qs({ ...filters, limit: PAGE, after, before })}`;
  const { data, error, loading, reload } = useApi<RequestLogPage>(path);
  const keys = useApi<{ data: ApiKey[] }>("/api-keys");
  const rows = data?.data ?? [];

  // A filter change goes back to the first page.
  const set = (patch: Record<string, string | null>) =>
    setQuery({ after: null, before: null, log: null, ...patch });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onSearch = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => set({ q: v.trim() || null }), 300);
  };

  const first = rows[0];
  const last = rows[rows.length - 1];
  const hasNext = before ? true : Boolean(data?.has_more);
  const hasPrev = after ? true : before ? Boolean(data?.has_more) : false;
  const open = rows.find((r) => r.id === selected) ?? null;

  let body: ReactNode;

  if (error && !data) {
    body = (
      <ErrorState
        error={error}
        title="Could not load the logs"
        onRetry={() => void reload()}
      />
    );
  } else if (!data) {
    body = loading ? (
      <>
        <TableHead template={COLS} columns={HEAD} />
        <Skeleton rows={6} />
      </>
    ) : null;
  } else if (rows.length === 0) {
    body = <Empty enabled={data.enabled} filtered={active > 0} />;
  } else {
    body = (
      <div role="group" aria-label="Logs">
        <TableHead template={COLS} columns={HEAD} />
        {rows.map((r) => (
          <LogRow
            key={r.id}
            r={r}
            narrow={narrow}
            onOpen={() => setQuery({ log: r.id })}
          />
        ))}
      </div>
    );
  }

  const controls = (
    <>
      <div className="w-[170px] max-md:flex-1">
        <Select
          aria-label="Status"
          value={filters.status ?? ""}
          options={STATUSES}
          onChange={(v) => set({ status: v || null })}
          className="h-11 md:h-9"
        />
      </div>
      <div className="w-[140px] max-md:flex-1">
        <Select
          aria-label="Method"
          value={filters.method ?? ""}
          options={METHODS}
          onChange={(v) => set({ method: v || null })}
          className="h-11 md:h-9"
        />
      </div>
      <div className="w-[180px] max-md:flex-1">
        <Select
          aria-label="API key"
          value={filters.key ?? ""}
          options={[
            { value: "", label: "all keys" },
            ...(keys.data?.data ?? []).map((k) => ({
              value: k.id,
              label: k.name,
            })),
          ]}
          onChange={(v) => set({ key: v || null })}
          className="h-11 md:h-9"
        />
      </div>
      {active > 0 && (
        <button
          type="button"
          onClick={() =>
            set({ status: null, method: null, key: null, q: null })
          }
          className="h-11 border-0 bg-transparent px-2 font-mono text-[12px] text-fg2 underline underline-offset-3 hover:text-fg md:ml-auto md:h-9"
        >
          clear filters
        </button>
      )}
    </>
  );

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        title="Logs"
        subtitle="Each call to the Resend API routes. fullsend keeps them for 14 days."
        actions={
          <Button icon="reload" className="h-10" onClick={() => void reload()}>
            refresh
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-3 font-mono text-[12px] md:px-8">
        <label className="relative flex min-w-0 basis-full md:w-[300px] md:basis-auto">
          <span className="sr-only">Search by path</span>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-fg3"
          />
          <Input
            data-list-search
            type="search"
            // The key restarts the field when a filter reset clears the text.
            key={filters.q ?? ""}
            defaultValue={filters.q ?? ""}
            placeholder="path"
            onChange={(e) => onSearch(e.target.value)}
            className="h-11 pl-9 md:h-9"
          />
        </label>
        {controls}
      </div>
      {body}
      {data && rows.length > 0 && (
        <Pager
          hasPrev={hasPrev}
          hasNext={hasNext}
          full
          note={`newest first · ${PAGE} per page`}
          onPrev={() =>
            first && setQuery({ before: first.id, after: null, log: null })
          }
          onNext={() =>
            last && setQuery({ after: last.id, before: null, log: null })
          }
        />
      )}
      <SidePanel
        open={open !== null}
        onClose={() => setQuery({ log: null })}
        title="Request detail"
        width={560}
      >
        {open && <Detail r={open} />}
      </SidePanel>
    </div>
  );
}

function LogRow({
  r,
  narrow,
  onOpen,
}: {
  r: RequestLog;
  narrow: boolean;
  onOpen: () => void;
}) {
  if (narrow)
    return (
      <TableRow template={COLS} onOpen={onOpen} className="min-h-11">
        <span className="flex items-center gap-2">
          <span className="font-mono text-[12px] font-semibold">
            {r.method}
          </span>
          <StatusBadge status={r.status} />
          <RelTime at={r.created_at} className="ml-auto text-fg3" />
        </span>
        <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">
          {r.path}
        </span>
        {r.error_name && (
          <span className="font-mono text-[12px] text-red">{r.error_name}</span>
        )}
        <span className="font-mono text-[12px] text-fg3">
          {r.api_key?.name ?? "no key"} · {duration(r.duration_ms)}
        </span>
      </TableRow>
    );

  return (
    <TableRow template={COLS} onOpen={onOpen} className="min-h-11">
      <RelTime at={r.created_at} className="text-fg2" />
      <span className="font-mono text-[12.5px] font-semibold">{r.method}</span>
      <span className="truncate font-mono text-[12.5px]">{r.path}</span>
      <span>
        <StatusBadge status={r.status} />
      </span>
      <span className="truncate font-mono text-[12px] text-fg2">
        {r.api_key?.name ?? "-"}
      </span>
      <span className="font-mono text-[12px] text-fg2">
        {duration(r.duration_ms)}
      </span>
      <span className="truncate font-mono text-[12px] text-red">
        {r.error_name ?? ""}
      </span>
    </TableRow>
  );
}

function Empty({ enabled, filtered }: { enabled: boolean; filtered: boolean }) {
  if (filtered)
    return (
      <EmptyState icon="search" title="No requests match">
        Change or clear the filters.
      </EmptyState>
    );

  if (!enabled)
    return (
      <EmptyState
        icon="alert"
        title="The request log is off"
        action={<TextLink href="/settings">Open the settings</TextLink>}
      >
        fullsend does not record API requests now. Turn the log on in the
        settings to see them here.
      </EmptyState>
    );

  return (
    <EmptyState icon="list-box" title="No requests yet">
      fullsend records each call to the Resend API routes here. It keeps them
      for 14 days.
    </EmptyState>
  );
}

function Detail({ r }: { r: RequestLog }) {
  const rows: [string, ReactNode][] = [
    ["Time", utc(r.created_at)],
    ["Method", r.method],
    [
      "Path",
      <span key="p" className="[overflow-wrap:anywhere]">
        {r.path}
      </span>,
    ],
    ["Status", <StatusBadge key="s" status={r.status} />],
    ["API key", r.api_key ? `${r.api_key.name} (${r.api_key.id})` : "none"],
    ["Time taken", duration(r.duration_ms)],
    ["Error name", r.error_name ?? "-"],
    ["Error message", r.error_message ?? "-"],
    ["Log id", r.id],
  ];

  return (
    <dl className="m-0 flex flex-col px-6 py-3">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex flex-col gap-0.5 border-b border-line py-2.5 last:border-b-0"
        >
          <dt className="text-[12.5px] text-fg3">{label}</dt>
          <dd className="m-0 font-mono text-[13px] [overflow-wrap:anywhere]">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
