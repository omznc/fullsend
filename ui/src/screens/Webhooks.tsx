import { useState } from "react";
import { api, type Webhook } from "../api";
import {
  Badge,
  Button,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  Icon,
  Notice,
  PageHeader,
  RelTime,
  SkeletonBlock,
  TableHead,
  TableRow,
  errorText,
} from "../components/ui";
import { percent } from "../lib/format";
import { useApi, useTitle } from "../lib/hooks";
import {
  checkEndpoint,
  EndpointFields,
  SecretDialog,
  shortEvent,
} from "./webhooks/shared";

const TEMPLATE = "minmax(0,1fr) 160px 150px 260px 40px";

const COLUMNS = ["endpoint", "events", "status", "success, 7 days", ""];

interface WebhookList {
  data: Webhook[];
  events: string[];
}

export function Webhooks() {
  useTitle("Webhooks");
  const hooks = useApi<WebhookList>("/webhooks");
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const list = hooks.data?.data;

  return (
    <>
      <PageHeader
        title="Webhooks"
        subtitle="fullsend calls these URLs when something happens to an email, so your app can react."
        actions={
          <Button
            variant="primary"
            icon="plus"
            className="max-md:h-11"
            disabled={!hooks.data}
            onClick={() => setAdding(true)}
          >
            add endpoint
          </Button>
        }
      />
      <TableHead template={TEMPLATE} columns={COLUMNS} />
      {hooks.error && !list ? (
        <ErrorState
          error={hooks.error}
          title="Could not load webhooks"
          onRetry={() => void hooks.reload()}
        />
      ) : !list ? (
        <HookSkeleton show={hooks.loading} />
      ) : list.length === 0 ? (
        <EmptyState
          icon="link"
          title="No endpoints yet"
          action={
            <Button
              variant="primary"
              icon="plus"
              onClick={() => setAdding(true)}
            >
              add endpoint
            </Button>
          }
        >
          Add a URL and fullsend calls it when an email is sent, delivered,
          bounced or opened.
        </EmptyState>
      ) : (
        list.map((h) => (
          <HookRow key={h.id} hook={h} total={hooks.data?.events.length ?? 0} />
        ))
      )}
      <p className="m-0 px-4 py-3.5 text-[13px] text-fg2 md:px-8">
        The bar shows the share of successful calls in the last 7 days. Red is
        the share of failed calls. fullsend retries a failed call up to 7 times
        over about 27 hours, then gives up.
      </p>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add endpoint"
        width={560}
      >
        <AddForm
          events={hooks.data?.events ?? []}
          onCancel={() => setAdding(false)}
          onCreated={(w) => {
            setAdding(false);
            setSecret(w.signing_secret ?? null);
            void hooks.reload();
          }}
        />
      </Dialog>
      <SecretDialog
        secret={secret}
        title="Endpoint added"
        onClose={() => setSecret(null)}
      />
    </>
  );
}

function HookRow({ hook: h, total }: { hook: Webhook; total: number }) {
  const all = total > 0 && h.events.length === total;
  const failing = h.status === "failing";
  const off = h.status === "disabled";
  const names = h.events.map(shortEvent).join(", ");

  return (
    <TableRow
      template={TEMPLATE}
      href={`/webhooks/${h.id}`}
      className="min-h-15 max-md:min-h-11"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-[13px] font-semibold">
          {h.endpoint}
        </span>
        <span
          className={
            failing ? "text-[12.5px] text-amber" : "text-[12.5px] text-fg3"
          }
        >
          {off ? (
            "turned off"
          ) : h.last_attempt_at ? (
            <>
              last call <RelTime at={h.last_attempt_at} />
              {failing && ". Most calls failed."}
            </>
          ) : (
            "no calls yet"
          )}
        </span>
      </span>
      <span
        className="flex items-center gap-1 font-mono text-[12.5px]"
        title={all ? "all events" : names}
      >
        <Icon name="bulletlist" className="text-fg3" />
        {all
          ? "all events"
          : `${h.events.length} ${h.events.length === 1 ? "event" : "events"}`}
      </span>
      <span>
        <Badge status={h.status} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2.5">
          <RateBar rate={h.success_rate} off={off} />
          <span className="w-[46px] text-right font-mono text-[12.5px] font-semibold">
            {h.success_rate === null ? "none" : percent(h.success_rate)}
          </span>
        </span>
        <span className="text-[12px] text-fg3">
          {h.attempts_7d === 1 ? "1 call" : `${h.attempts_7d} calls`} in 7 days
        </span>
      </span>
      <Icon name="chevron-right" className="text-fg3 max-md:hidden" />
    </TableRow>
  );
}

// One bar for the last 7 days: green is the share of successful calls.
function RateBar({ rate, off }: { rate: number | null; off: boolean }) {
  return (
    <span
      role="img"
      aria-label={
        rate === null ? "No calls in 7 days" : `${percent(rate)} succeeded`
      }
      className="flex h-2.5 flex-1 overflow-hidden bg-line2"
    >
      {rate !== null && (
        <>
          <span
            className={off ? "bg-fg3" : "bg-green"}
            style={{ width: `${rate * 100}%` }}
          />
          <span className="bg-red" style={{ width: `${(1 - rate) * 100}%` }} />
        </>
      )}
    </span>
  );
}

function HookSkeleton({ show }: { show: boolean }) {
  if (!show) return <div className="h-15" />;

  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: 3 }, (_, i) => (
        <div
          key={i}
          className="grid min-h-15 grid-cols-1 items-center gap-2 border-b border-line px-4 py-3 md:gap-x-4 md:px-8 md:py-1 md:[grid-template-columns:var(--cols)]"
          style={{ "--cols": TEMPLATE }}
        >
          <span className="flex flex-col gap-1.5">
            <SkeletonBlock className="h-2.5 w-3/5" />
            <SkeletonBlock className="h-2 w-1/4" />
          </span>
          <SkeletonBlock className="h-2.5 w-20" />
          <SkeletonBlock className="h-[22px] w-20" />
          <SkeletonBlock className="h-2.5 w-full" />
          <span />
        </div>
      ))}
    </div>
  );
}

function AddForm({
  events,
  onCancel,
  onCreated,
}: {
  events: string[];
  onCancel: () => void;
  onCreated: (w: Webhook) => void;
}) {
  const [endpoint, setEndpoint] = useState("");
  const [picked, setPicked] = useState<string[]>(events);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = checkEndpoint(endpoint);
  const ready = endpoint.trim() !== "" && !check.error && picked.length > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);

    try {
      onCreated(
        await api<Webhook>("/webhooks", {
          method: "POST",
          body: { endpoint: endpoint.trim(), events: picked },
        }),
      );
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();

        if (ready) void submit();
      }}
    >
      <EndpointFields
        all={events}
        endpoint={endpoint}
        picked={picked}
        onEndpoint={setEndpoint}
        onPicked={setPicked}
      />
      {error && <Notice tone="red">{error}</Notice>}
      <DialogFooter>
        <Button onClick={onCancel}>cancel</Button>
        <Button
          type="submit"
          variant="primary"
          icon="link"
          busy={busy}
          disabled={!ready}
        >
          add endpoint
        </Button>
      </DialogFooter>
    </form>
  );
}
