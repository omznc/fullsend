import { type ReactNode, useState } from "react";
import { api, type Delivery, qs, type Webhook } from "../api";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  MaskedSecret,
  Notice,
  RelTime,
  SidePanel,
  SkeletonBlock,
  TableHead,
  TableRow,
  TextLink,
  Pager,
  cx,
  errorText,
  useToast,
} from "../components/ui";
import { percent } from "../lib/format";
import { useApi, useNow, useTitle } from "../lib/hooks";
import { isJsonObject, isString, parseJson } from "../lib/json";
import { Link, navigate, useQuery } from "../lib/router";
import { SecretDialog, shortEvent } from "./webhooks/shared";

const TEMPLATE = "170px 170px 110px 100px 90px minmax(0,1fr) 40px";

const COLUMNS = [
  "event",
  "message",
  "status",
  "duration",
  "attempt",
  "time",
  "",
];

const LIMIT = 20;

// The Worker sends a call up to 8 times. The delay before each retry, in
// seconds, is from worker/src/webhooks/deliver.ts.
const MAX_ATTEMPTS = 8;

const RETRY_DELAYS = [5, 300, 1800, 7200, 18000, 36000, 36000];

interface DeliveryList {
  has_more: boolean;
  data: Delivery[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const duration = (ms: number | null) =>
  ms === null ? "-" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;

// The label of a delivery result: the status code, or the kind of failure.
function resultLabel(d: Delivery): string {
  if (d.status_code !== null) return String(d.status_code);

  return /timeout|abort/i.test(d.error ?? "") ? "timeout" : "error";
}

function ResultBadge({ d }: { d: Delivery }) {
  return (
    <Badge
      status={d.ok ? "delivered" : "failed"}
      label={resultLabel(d)}
      tone={d.ok ? "green" : "red"}
      hollow={false}
    />
  );
}

export function WebhookDetail({ id }: { id: string }) {
  const toast = useToast();
  const [query, setQuery] = useQuery();
  const after = query.get("after");
  const before = query.get("before");
  const selected = query.get("delivery");

  const hook = useApi<Webhook>(`/webhooks/${id}`);

  const deliveries = useApi<DeliveryList>(
    `/webhooks/${id}/deliveries${qs({ limit: LIMIT, after, before })}`,
  );

  useTitle(hook.data?.endpoint ?? "Webhook");

  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const w = hook.data;
  const list = deliveries.data?.data;

  // Sends a test event, then looks for its delivery for about 15 s.
  const sendTest = async () => {
    setTesting(true);

    try {
      const { message_id } = await api<{ message_id: string }>(
        `/webhooks/${id}/test`,
        { method: "POST", body: {} },
      );

      let found: Delivery | undefined;

      for (let i = 0; i < 10 && !found; i++) {
        await sleep(1500);

        const page = await api<DeliveryList>(
          `/webhooks/${id}/deliveries?limit=10`,
        );

        found = page.data.find((d) => d.message_id === message_id);
      }

      void deliveries.reload();
      void hook.reload();

      if (!found)
        toast({
          tone: "info",
          message: "Test event queued. Its delivery has not arrived yet.",
        });
      else if (found.ok)
        toast({
          tone: "success",
          message: `Test event delivered. Your endpoint answered ${found.status_code}.`,
        });
      else
        toast({
          tone: "error",
          message: `Test event failed: ${resultLabel(found)}.`,
          action: {
            label: "details",
            href: `/webhooks/${id}?delivery=${found.id}`,
          },
        });
    } catch (err) {
      toast({ tone: "error", message: errorText(err) });
    } finally {
      setTesting(false);
    }
  };

  const toggle = async () => {
    if (!w) return;
    setToggling(true);

    try {
      await api(`/webhooks/${id}`, {
        method: "PATCH",
        body: { status: w.enabled ? "disabled" : "enabled" },
      });
      await hook.reload();
    } catch (err) {
      toast({ tone: "error", message: errorText(err) });
    } finally {
      setToggling(false);
    }
  };

  const crumbs = (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center font-mono text-[12.5px] text-fg3"
    >
      <Link href="/webhooks" className="text-fg2 no-underline">
        webhooks
      </Link>
      <Icon name="chevron-right" />
      <span className="text-fg">{id.slice(0, 8)}</span>
    </nav>
  );

  if (hook.error && !w)
    return (
      <>
        <div className="px-4 pt-5 md:px-8">{crumbs}</div>
        <ErrorState
          error={hook.error}
          title="Could not load this endpoint"
          onRetry={() => void hook.reload()}
        />
      </>
    );

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-5 md:px-8">
        <div className="flex min-w-0 flex-col gap-2">
          {crumbs}
          {w ? (
            <>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="m-0 font-mono text-[20px] leading-[30px] font-semibold tracking-[-0.03em] [overflow-wrap:anywhere] md:text-[24px]">
                  {w.endpoint}
                </h1>
                <Badge status={w.status} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {w.events.map((e) => (
                  <span
                    key={e}
                    className="border border-line2 px-1.5 font-mono text-[11.5px] leading-5 text-fg2"
                  >
                    {shortEvent(e)}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div
              aria-busy="true"
              aria-label="Loading"
              className="flex flex-col gap-3"
            >
              <SkeletonBlock className="h-6 w-80 max-w-full" />
              <SkeletonBlock className="h-5 w-56" />
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button
            icon="mail-arrow-right"
            className="max-md:h-11"
            busy={testing}
            disabled={!w?.enabled}
            title={w && !w.enabled ? "Turn the endpoint on first" : undefined}
            onClick={() => void sendTest()}
          >
            send test event
          </Button>
          <Button
            icon={w?.enabled === false ? "play" : "pause"}
            className="max-md:h-11"
            busy={toggling}
            disabled={!w}
            onClick={() => void toggle()}
          >
            {w?.enabled === false ? "enable" : "disable"}
          </Button>
          <IconButton
            icon="trash"
            label="Delete endpoint"
            size={44}
            bordered
            className="text-red"
            disabled={!w}
            onClick={() => setDeleting(true)}
          />
        </div>
      </header>

      <div className="grid grid-cols-1 border-b border-line md:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex items-start gap-3 border-b border-line bg-panel px-4 py-4 md:border-r md:border-b-0 md:px-8 md:py-[18px]">
          <Summary hook={w} list={list} />
        </div>
        <div className="flex flex-col gap-1.5 px-4 py-3.5 md:px-8">
          <span className="text-[13px] text-fg2">Signing secret</span>
          {w?.signing_secret ? (
            <MaskedSecret
              secret={w.signing_secret}
              onRotate={() => setRotating(true)}
            />
          ) : (
            <SkeletonBlock className="h-10 w-full" />
          )}
        </div>
      </div>

      <div className="border-b border-line px-4 py-3 font-semibold md:px-8">
        Deliveries
      </div>
      {deliveries.error && !list ? (
        <ErrorState
          error={deliveries.error}
          title="Could not load deliveries"
          onRetry={() => void deliveries.reload()}
        />
      ) : !list ? (
        <>
          <TableHead template={TEMPLATE} columns={COLUMNS} />
          <DeliverySkeleton show={deliveries.loading} />
        </>
      ) : list.length === 0 && !after && !before ? (
        <EmptyState
          icon="link"
          title="No calls yet"
          action={
            <Button
              variant="primary"
              icon="mail-arrow-right"
              busy={testing}
              disabled={!w?.enabled}
              onClick={() => void sendTest()}
            >
              send test event
            </Button>
          }
        >
          This endpoint gets a call as soon as one of its events happens. Send a
          test event to try it now.
        </EmptyState>
      ) : (
        <>
          <TableHead
            template={TEMPLATE}
            columns={[
              ...COLUMNS.slice(0, 5),
              <span key="t" className="flex items-center text-fg">
                time
                <Icon name="arrow-down" />
              </span>,
              "",
            ]}
          />
          {list.map((d) => (
            <TableRow
              key={d.id}
              template={TEMPLATE}
              danger={!d.ok}
              className={cx("md:min-h-12", !d.ok && "bg-red/[0.07]")}
              onOpen={() => setQuery({ delivery: d.id })}
            >
              <span className="font-mono text-[12.5px]">{d.event_type}</span>
              <span
                className="truncate font-mono text-[12.5px] text-fg2"
                title={d.message_id}
              >
                {d.message_id}
              </span>
              <span>
                <ResultBadge d={d} />
              </span>
              <span className="font-mono text-[12.5px] text-fg2">
                {duration(d.duration_ms)}
              </span>
              <span className="font-mono text-[12.5px] text-fg2">
                attempt {d.attempt}
              </span>
              <span className="text-fg2">
                <RelTime at={d.created_at} />
              </span>
              <Icon name="chevron-right" className="text-fg3 max-md:hidden" />
            </TableRow>
          ))}
          <Pager
            hasPrev={before ? deliveries.data!.has_more : Boolean(after)}
            hasNext={before ? true : deliveries.data!.has_more}
            onPrev={() =>
              before || after
                ? setQuery({
                    before: list[0]?.id,
                    after: null,
                    delivery: null,
                  })
                : undefined
            }
            onNext={() =>
              setQuery({
                after: list[list.length - 1]?.id,
                before: null,
                delivery: null,
              })
            }
          />
        </>
      )}

      <SidePanel
        open={selected !== null}
        onClose={() => setQuery({ delivery: null })}
        title="Delivery detail"
        width={600}
      >
        {selected && (
          <DeliveryPanel
            key={selected}
            webhook={w}
            id={id}
            deliveryId={selected}
            siblings={list ?? []}
            onResent={() => void deliveries.reload()}
          />
        )}
      </SidePanel>

      <ConfirmDialog
        open={deleting}
        title="Delete this endpoint?"
        body={
          <>
            fullsend stops calling{" "}
            <code className="font-mono text-fg">{w?.endpoint}</code> and deletes
            its delivery log.
          </>
        }
        action="delete endpoint"
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await api(`/webhooks/${id}`, { method: "DELETE" });
          navigate("/webhooks");
        }}
      />
      <ConfirmDialog
        open={rotating}
        title="Rotate the signing secret?"
        body="The old secret stops working at once. Update your app with the new secret, or it will reject calls from fullsend."
        action="rotate secret"
        onClose={() => setRotating(false)}
        onConfirm={async () => {
          const r = await api<{ signing_secret: string }>(
            `/webhooks/${id}/rotate`,
            { method: "POST", body: {} },
          );

          setNewSecret(r.signing_secret);
          await hook.reload();
        }}
      />
      <SecretDialog
        secret={newSecret}
        title="New signing secret"
        onClose={() => setNewSecret(null)}
      />
    </>
  );
}

// The summary of the recent calls, from the deliveries on this page.
function Summary({
  hook,
  list,
}: {
  hook: Webhook | null;
  list: Delivery[] | undefined;
}) {
  if (!hook || !list)
    return (
      <div className="flex w-full flex-col gap-2" aria-busy="true">
        <SkeletonBlock className="h-5 w-3/4" />
        <SkeletonBlock className="h-5 w-1/2" />
      </div>
    );
  const failed = list.filter((d) => !d.ok);
  const last = failed[0];

  const rate =
    hook.success_rate === null
      ? null
      : `${percent(hook.success_rate)} of ${hook.attempts_7d} calls in 7 days succeeded.`;

  let icon = "check";
  let color = "text-green";
  let head: ReactNode;
  let tail: ReactNode = rate;

  if (!hook.enabled) {
    icon = "pause";
    color = "text-fg3";
    head = "This endpoint is turned off. ";
    tail = "fullsend sends no calls to it until you turn it on.";
  } else if (list.length === 0) {
    icon = "clock";
    color = "text-fg3";
    head = "No calls yet. ";
    tail = "The first call shows here.";
  } else if (!last) {
    head = `All ${list.length} recent calls worked. `;
  } else {
    icon = "warning-box";
    color = "text-amber";
    head = `${failed.length} of ${list.length} recent calls failed, `;
    tail = (
      <>
        the latest was a {resultLabel(last)} <RelTime at={last.created_at} />.{" "}
        {list[0]?.ok ? "The newest call worked. " : "The newest call failed. "}
        {rate}
      </>
    );
  }

  return (
    <>
      <Icon name={icon} className={cx("mt-0.5 shrink-0", color)} />
      <p className="m-0 text-[17px] leading-7 font-medium md:text-[20px]">
        {head}
        <span className="text-fg2">{tail}</span>
      </p>
    </>
  );
}

function DeliverySkeleton({ show }: { show: boolean }) {
  if (!show) return <div className="h-12" />;
  const widths = ["60%", "70%", "55%", "65%", "50%", "72%", "58%", "62%"];

  return (
    <div aria-busy="true" aria-label="Loading">
      {widths.map((w, i) => (
        <div
          key={i}
          className="grid h-12 grid-cols-1 items-center border-b border-line px-4 md:gap-x-4 md:px-8 md:[grid-template-columns:170px_170px_110px_100px_90px_minmax(0,1fr)_40px]"
        >
          <SkeletonBlock className="h-2.5" style={{ width: w }} />
          <SkeletonBlock className="h-2.5 w-[70%] max-md:hidden" />
          <SkeletonBlock className="h-[22px] w-[50px] max-md:hidden" />
          <SkeletonBlock className="h-2.5 w-[50px] max-md:hidden" />
          <SkeletonBlock className="h-2.5 w-5 max-md:hidden" />
          <SkeletonBlock className="h-2.5 w-20 max-md:hidden" />
          <span />
        </div>
      ))}
    </div>
  );
}

// Colors the keys and the strings of a JSON text.
function Json({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /("(?:[^"\\\n]|\\.)*")(\s*:)?/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span
        key={k++}
        style={{ color: m[2] ? "var(--accent-fg)" : "var(--green)" }}
      >
        {m[1]}
      </span>,
    );

    if (m[2]) parts.push(m[2]);
    last = m.index + m[0].length;
  }

  parts.push(text.slice(last));

  return <>{parts}</>;
}

const preClass =
  "m-0 mx-6 overflow-x-auto bg-panel px-3 py-2.5 font-mono text-[12px] leading-[19px] whitespace-pre-wrap [overflow-wrap:anywhere]";

function DeliveryPanel({
  webhook,
  id,
  deliveryId,
  siblings,
  onResent,
}: {
  webhook: Webhook | null;
  id: string;
  deliveryId: string;
  siblings: Delivery[];
  onResent: () => void;
}) {
  const toast = useToast();
  const now = useNow(1000);
  const d = useApi<Delivery>(`/webhooks/${id}/deliveries/${deliveryId}`);
  const [resending, setResending] = useState(false);
  const x = d.data;

  if (d.error && !x)
    return (
      <ErrorState
        error={d.error}
        title="Could not load this delivery"
        onRetry={() => void d.reload()}
      />
    );

  if (!x)
    return (
      <div
        aria-busy="true"
        aria-label="Loading"
        className="flex flex-col gap-3 p-6"
      >
        <SkeletonBlock className="h-5 w-48" />
        <SkeletonBlock className="h-24 w-full" />
        <SkeletonBlock className="h-16 w-full" />
      </div>
    );

  let path = "/";

  try {
    const u = new URL(webhook?.endpoint ?? "");
    path = u.pathname + u.search;
  } catch {
    // Keep the default path.
  }

  let body = x.request_body ?? "";
  let emailId: string | null = null;

  try {
    const parsed = parseJson(body);
    body = JSON.stringify(parsed, null, 2);
    const data = isJsonObject(parsed) ? parsed.data : undefined;
    const email = isJsonObject(data) ? data.email_id : undefined;

    if (isString(email)) emailId = email;
  } catch {
    // Show the raw body.
  }

  const later = siblings.some(
    (s) => s.message_id === x.message_id && s.attempt > x.attempt,
  );

  const delay = RETRY_DELAYS[x.attempt - 1];

  const nextAt =
    !x.ok && !later && webhook?.enabled && delay !== undefined
      ? new Date(x.created_at).getTime() + delay * 1000
      : null;

  let note: ReactNode;

  if (x.ok) note = "This call worked.";
  else if (x.attempt >= MAX_ATTEMPTS)
    note = `All ${MAX_ATTEMPTS} attempts failed. fullsend gave up.`;
  else if (later) note = "A later attempt of this call is in the log.";
  else if (nextAt === null)
    note = "This endpoint is turned off, so no retry runs.";
  else
    note = (
      <>
        {nextAt > now ? (
          <>
            Next attempt in {Math.max(1, Math.round((nextAt - now) / 1000))}{" "}
            s.{" "}
          </>
        ) : (
          <>A retry is due. </>
        )}
        <span className="text-fg2">
          Failed calls retry after 5 s, 5 min, 30 min, 2 h, 5 h, 10 h and 10 h.
        </span>
      </>
    );

  const resend = async () => {
    setResending(true);

    try {
      await api(`/webhooks/${id}/deliveries/${deliveryId}/resend`, {
        method: "POST",
        body: {},
      });
      toast({ tone: "info", message: "Resend queued." });
      setTimeout(onResent, 3000);
    } catch (err) {
      toast({ tone: "error", message: errorText(err) });
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="flex flex-col pb-4">
      <div className="flex flex-wrap items-center gap-2.5 px-6 py-3">
        <span className="font-mono text-[13px] font-semibold">
          {x.event_type}
        </span>
        <ResultBadge d={x} />
        <span className="font-mono text-[12px] text-fg3">
          attempt {x.attempt} of {MAX_ATTEMPTS}
        </span>
        <RelTime at={x.created_at} className="text-fg2" />
      </div>
      <div className="flex items-center gap-2.5 border-y border-line bg-panel px-6 py-3">
        <Icon
          name={x.ok ? "check" : "clock"}
          className={x.ok ? "text-green" : "text-amber"}
        />
        <span className="flex-1">{note}</span>
        <Button
          variant="primary"
          size="sm"
          icon="reload"
          busy={resending}
          className="max-md:h-11"
          onClick={() => void resend()}
        >
          resend now
        </Button>
      </div>
      <div className="flex items-center justify-between px-6 pt-3 pb-1">
        <span className="text-[13px] font-semibold text-fg">Request</span>
        {emailId && (
          <TextLink
            href={`/emails/${emailId}`}
            icon="mail"
            className="font-mono text-[12px]"
          >
            open email
          </TextLink>
        )}
      </div>
      <pre className={preClass}>
        <span className="text-fg3">
          {`POST ${path}\ncontent-type: application/json\nsvix-id: ${x.message_id}`}
        </span>
        {"\n\n"}
        <Json text={body} />
      </pre>
      <span className="px-6 pt-1 font-mono text-[11.5px] text-fg3">
        fullsend makes svix-timestamp and svix-signature again for each attempt.
        It does not store them.
      </span>
      <div className="px-6 pt-3 pb-1 text-[13px] font-semibold text-fg">
        Response · {resultLabel(x)} · {duration(x.duration_ms)}
      </div>
      <pre className={preClass}>
        {x.error ? (
          <span className="text-red">{x.error}</span>
        ) : x.response_excerpt ? (
          <span className={x.ok ? undefined : "text-red"}>
            {x.response_excerpt}
          </span>
        ) : (
          <span className="text-fg3">The endpoint sent no body.</span>
        )}
      </pre>
      <span className="px-6 pt-1.5 font-mono text-[11.5px] text-fg3">
        first 1000 characters of the body
      </span>
      {!x.ok && x.status_code === null && (
        <Notice tone="amber" className="mx-6 mt-3">
          No answer came from the endpoint. fullsend waits 15 s for one.
        </Notice>
      )}
    </div>
  );
}
