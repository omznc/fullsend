import { useState } from "react";
import { api, qs, type List, type SystemEvent } from "../api";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  errorText,
  Icon,
  PageHeader,
  RelTime,
  Skeleton,
  TableHead,
  TableRow,
  useToast,
} from "../components/ui";
import { useApi, useTitle } from "../lib/hooks";

const LIMIT = 50;

const COLS = "90px 130px minmax(0,1fr) 150px 40px";

const tone = (level: string) =>
  level === "error" ? "red" : level === "warn" ? "amber" : "gray";

// The failures that are not tied to one email. Newest first.
export function System() {
  useTitle("System events");
  const toast = useToast();

  const first = useApi<List<SystemEvent>>(
    `/system-events${qs({ limit: LIMIT })}`,
  );

  // The pages after the first one. A reload of the first page clears them.
  const [more, setMore] = useState<List<SystemEvent> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const rows = [...(first.data?.data ?? []), ...(more?.data ?? [])];
  const hasMore = more ? more.has_more : Boolean(first.data?.has_more);

  const loadMore = () => {
    const last = rows[rows.length - 1];

    if (!last) return;
    setLoadingMore(true);
    setMoreError(null);
    api<List<SystemEvent>>(
      `/system-events${qs({ limit: LIMIT, after: last.id })}`,
    )
      .then(
        (page) => {
          setMore((m) => ({
            has_more: page.has_more,
            data: [...(m?.data ?? []), ...page.data],
          }));

          return undefined;
        },
        (cause: unknown) => {
          setMoreError(errorText(cause));

          return undefined;
        },
      )
      .then(() => setLoadingMore(false));
  };

  const clear = async () => {
    const res = await api<{ deleted: number }>("/system-events", {
      method: "DELETE",
    });

    toast({
      tone: "success",
      message: `${res.deleted} system event${res.deleted === 1 ? "" : "s"} cleared.`,
    });
    setMore(null);
    setOpen(null);
    await first.reload();
  };

  return (
    <>
      <PageHeader
        title="System events"
        subtitle="Failures that belong to no single email: the cron, the queues and the webhooks."
        actions={
          <Button
            icon="trash"
            disabled={rows.length === 0}
            onClick={() => setClearing(true)}
          >
            clear
          </Button>
        }
      />
      {first.error && !first.data && (
        <ErrorState
          error={first.error}
          title="Could not load system events"
          onRetry={() => void first.reload()}
        />
      )}
      {first.loading && !first.data && (
        <>
          <TableHead
            template={COLS}
            columns={["level", "source", "message", "when", ""]}
          />
          <Skeleton rows={5} />
        </>
      )}
      {first.data && rows.length === 0 && (
        <EmptyState icon="check" title="No system events">
          fullsend logs a failure here when a job, a queue or a webhook fails
          for good.
        </EmptyState>
      )}
      {rows.length > 0 && (
        <div role="group" aria-label="System events">
          <TableHead
            template={COLS}
            columns={["level", "source", "message", "when", ""]}
          />
          {rows.map((e) => (
            <EventRow
              key={e.id}
              e={e}
              shown={open === e.id}
              onToggle={() => setOpen(open === e.id ? null : e.id)}
            />
          ))}
        </div>
      )}
      {moreError && (
        <p className="m-0 px-4 py-2 text-[12.5px] text-red md:px-8">
          {moreError}
        </p>
      )}
      {hasMore && (
        <div className="px-4 py-3 md:px-8">
          <Button busy={loadingMore} onClick={loadMore}>
            load more
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={clearing}
        title="Clear all system events?"
        body="fullsend deletes every system event. The overview then shows no errors until a new one comes."
        action="clear"
        onClose={() => setClearing(false)}
        onConfirm={clear}
      />
    </>
  );
}

// One event. A row with detail opens its JSON in place.
function EventRow({
  e,
  shown,
  onToggle,
}: {
  e: SystemEvent;
  shown: boolean;
  onToggle: () => void;
}) {
  const hasDetail = e.detail !== null;
  const panel = `system-detail-${e.id}`;

  return (
    <div>
      <TableRow
        template={COLS}
        expanded={hasDetail ? shown : undefined}
        controls={shown && hasDetail ? panel : undefined}
        onOpen={hasDetail ? onToggle : undefined}
      >
        <span>
          <Badge status={e.level} tone={tone(e.level)} />
        </span>
        <span className="font-mono text-[12.5px] text-fg2">{e.source}</span>
        <span className="[overflow-wrap:anywhere]">{e.message}</span>
        <RelTime at={e.created_at} className="text-fg2" />
        <span className="flex text-fg3 md:justify-end">
          {hasDetail && (
            <Icon name={shown ? "chevron-down" : "chevron-right"} size={16} />
          )}
        </span>
      </TableRow>
      {shown && hasDetail && (
        <pre
          id={panel}
          className="fs-fade m-0 overflow-x-auto border-b border-line bg-panel px-4 py-3 font-mono text-[12.5px] leading-5 md:px-8"
        >
          {JSON.stringify(e.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}
