import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiRequestError,
  type EmailBody,
  type EmailDetail as EmailDetailData,
  type EmailEvent,
  type Settings,
} from "../api";
import {
  Badge,
  Button,
  ButtonLink,
  ConfirmDialog,
  CopyButton,
  Dialog,
  Dot,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  Notice,
  SkeletonBlock,
  cx,
  errorText,
  useCopy,
  useToast,
} from "../components/ui";
import { address, bytes, clock, plainReason, utc } from "../lib/format";
import { useApi, useNarrow, useNow, useTitle } from "../lib/hooks";
import {
  isJsonObject,
  pick,
  type JsonObject,
  type JsonValue,
} from "../lib/json";
import { Link, navigate } from "../lib/router";
import { apiBase, useSession } from "../session";

// The email detail screen: the story, one timeline for each recipient,
// the body, the attachments and the details.

export function EmailDetail({ id }: { id: string }) {
  const res = useApi<EmailDetailData>(`/emails/${id}`);
  useTitle(res.data?.subject ?? "Email");

  if (res.error) {
    if (res.error instanceof ApiRequestError && res.error.status === 404) {
      return (
        <EmptyState
          icon="mail-off"
          title="Email not found"
          action={
            <ButtonLink href="/emails" icon="chevron-left">
              back to emails
            </ButtonLink>
          }
        >
          No email has this id. The email may be deleted after the retention
          period.
        </EmptyState>
      );
    }

    return (
      <ErrorState
        error={res.error}
        title="Could not load this email"
        onRetry={() => void res.reload()}
      />
    );
  }

  if (!res.data) return <DetailSkeleton visible={res.loading} />;

  return <Loaded email={res.data} reload={res.reload} />;
}

// Types and helpers

type Data = JsonObject | null;

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const pad = (n: number) => String(n).padStart(2, "0");

// "today 13:26", "oct 1, 09:00". Always in UTC.
function when(iso: string, now: number, seconds = false): string {
  const d = new Date(iso);
  const n = new Date(now);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""}`;

  const same =
    d.getUTCFullYear() === n.getUTCFullYear() &&
    d.getUTCMonth() === n.getUTCMonth() &&
    d.getUTCDate() === n.getUTCDate();

  return same
    ? `today ${hm}`
    : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hm}`;
}

// "tomorrow at 09:00 UTC", "on oct 3 at 09:00 UTC".
function whenLong(iso: string, now: number): string {
  const d = new Date(iso);
  const day = (t: number) => Math.floor(t / 86_400_000);
  const diff = day(d.getTime()) - day(now);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;

  if (diff <= 0) return `today at ${hm}`;

  if (diff === 1) return `tomorrow at ${hm}`;

  return `on ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} at ${hm}`;
}

const lower = (s: string) => s.toLowerCase();

const utcMs = (y: number, m: number, d: number, h = 0, min = 0) =>
  Date.UTC(y, m, d, h, min);

interface Recipient {
  addr: string;
  status: string;
  suppressed: boolean;
  events: EmailEvent[];
}

// An event without a recipient applies to all recipients. The exception is
// the suppression: it applies to the suppressed addresses only.
function recipientsOf(email: EmailDetailData): Recipient[] {
  const all = [
    ...new Set(
      [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])].map(lower),
    ),
  ];

  const sup = new Set(email.suppressed.map(lower));
  const wholeSuppressed = email.status === "suppressed";

  return all.map((addr) => {
    const isSup = sup.has(addr) || wholeSuppressed;

    const events = email.events.filter((e) => {
      if (e.recipient) return lower(e.recipient) === addr;

      if (e.type === "suppressed") return isSup;

      if (isSup) return ["queued", "scheduled", "canceled"].includes(e.type);

      return true;
    });

    const last = events.toReversed().find((e) => !e.bot);

    return {
      addr,
      suppressed: isSup,
      events,
      status: isSup ? "suppressed" : (last?.type ?? email.status),
    };
  });
}

const LABEL = new Map([
  ["delivery.smtpEnhancedStatusCode", "smtp status"],
  ["delivery.smtpStatusCode", "smtp code"],
  ["delivery.smtpResponse", "response"],
  ["delivery.provider", "provider"],
  ["delivery.status", "status"],
  ["delivery.deliveryTimeMs", "delivery time"],
  ["bounce.type", "bounce type"],
  ["bounce.classification", "class"],
  ["bounce.reason", "reason"],
  ["complaint.type", "complaint type"],
  ["link", "url"],
  ["user_agent", "user agent"],
  ["ip", "ip"],
  ["message_id", "message id"],
]);

// The event data as label and value rows.
function detailRows(data: Data): { k: string; v: string }[] {
  const rows: { k: string; v: string }[] = [];

  const walk = (v: JsonValue, path: string) => {
    if (v === null || v === "") return;

    if (Array.isArray(v)) {
      if (v.length) rows.push({ k: LABEL.get(path) ?? path, v: v.join(", ") });
    } else if (isJsonObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        walk(x, path ? `${path}.${k}` : k);
      }
    } else if (path !== "cf_type") {
      const text = String(v);
      rows.push({
        k: LABEL.get(path) ?? path.replace(/_/g, " "),
        v: path === "delivery.deliveryTimeMs" ? `${text} ms` : text,
      });
    }
  };

  walk(data, "");

  return rows;
}

// A short link for the click text: host and path.
function shortUrl(link: string): string {
  try {
    const u = new URL(link);

    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return link;
  }
}

function plainOf(
  e: EmailEvent,
  email: EmailDetailData,
  r: Recipient,
  now: number,
): string {
  const data = e.data;

  switch (e.type) {
    case "queued":
      return r.suppressed && email.status !== "suppressed"
        ? "Not sent. This address is on the suppression list."
        : "Accepted by the API";
    case "scheduled":
      return email.scheduled_at
        ? `Waits until ${whenLong(email.scheduled_at, now)}`
        : "Waits for its send time";
    case "sent":
      return "Handed to Cloudflare Email Service";
    case "delivered": {
      const p = pick(data, "delivery", "provider");

      return p ? `Accepted by ${p}` : "Accepted by the receiving server";
    }

    case "delivery_delayed":
      return "The receiving server asked to try again later";
    case "bounced": {
      const reason =
        pick(data, "bounce", "reason") ??
        pick(data, "delivery", "smtpResponse");

      const plain =
        plainReason(reason) ??
        plainReason(pick(data, "delivery", "smtpEnhancedStatusCode")) ??
        "The receiving server refused the email";

      return pick(data, "bounce", "type") === "hard"
        ? `${plain}. It is now suppressed.`
        : `${plain}.`;
    }

    case "failed": {
      const reason = pick(data, "reason") ?? pick(data, "bounce", "reason");

      return plainReason(reason) ?? reason ?? "The email failed to send";
    }

    case "complained":
      return "The person marked this email as spam";
    case "opened":
      return "Opened the email";
    case "clicked": {
      const link = pick(data, "link");

      return link ? `Clicked “${shortUrl(link)}”` : "Clicked a link";
    }

    case "canceled":
      return "Canceled before it was sent";
    case "suppressed":
      return email.status === "suppressed"
        ? "Not sent. This address is on the suppression list."
        : "Not sent to some addresses. They are on the suppression list.";
    default:
      return "";
  }
}

// An icon, a color, the main sentence `a` and the notes `b`.
interface Story {
  icon: string;
  color: string;
  a: string;
  b: string;
}

// The story at the top: the state of the email in plain words.
function storyOf(
  email: EmailDetailData,
  recipients: Recipient[],
  now: number,
  deletedNote: string | null,
): Story {
  const people = (n: number) => (n === 1 ? "1 person" : `${n} people`);

  if (email.status === "scheduled" && email.scheduled_at) {
    return {
      icon: "clock",
      color: "var(--blue)",
      a: `This email goes out ${whenLong(email.scheduled_at, now)}.`,
      b: "You can reschedule or cancel it until then.",
    };
  }

  if (email.status === "canceled") {
    return {
      icon: "close",
      color: "var(--fg2)",
      a: "This email was canceled.",
      b: "It was not sent.",
    };
  }

  if (email.status === "suppressed") {
    return {
      icon: "mail-off",
      color: "var(--amber)",
      a: "Not sent: every recipient is on the suppression list.",
      b: "Remove the address from Suppressions to email it again.",
    };
  }

  const n = recipients.length;

  const delivered = recipients.filter((r) =>
    ["delivered", "opened", "clicked"].includes(r.status),
  );

  const bad = recipients.filter((r) =>
    ["bounced", "failed", "complained"].includes(r.status),
  );

  const notes: string[] = [];

  const badEvent = (r: Recipient) =>
    r.events
      .toReversed()
      .find((e) => ["bounced", "failed", "complained"].includes(e.type));

  const reasons = bad.flatMap((r) => {
    const e = badEvent(r);
    const reason = e ? plainOf(e, email, r, now).replace(/\.$/, "") : "";

    return reason ? [reason] : [];
  });

  if (reasons.length) notes.push(`${[...new Set(reasons)].join(". ")}.`);
  const clicked = email.events.filter((e) => e.type === "clicked" && !e.bot);

  if (clicked.length) {
    const who = [...new Set(clicked.map((e) => e.recipient).filter(Boolean))];
    notes.push(
      who.length === 1
        ? `${who[0]} clicked a link.`
        : who.length > 1
          ? `${who.length} people clicked a link.`
          : "A link was clicked.",
    );
  }

  if (email.events.some((e) => e.bot)) {
    notes.push("Some opens and clicks came from bots, not from people.");
  }

  if (deletedNote) notes.push(deletedNote);

  let icon = "clock";
  let color = "var(--blue)";
  let a: string;

  if (bad.length) {
    icon = "warning-box";
    color = "var(--amber)";
    a = `Delivered to ${delivered.length} of ${n} ${n === 1 ? "person" : "people"}. ${bad.map((r) => r.addr).join(", ")} did not get it.`;
  } else if (email.status === "failed") {
    icon = "warning-box";
    color = "var(--red)";
    a = "This email failed to send.";
    const why = plainReason(email.error) ?? email.error;

    if (why) notes.unshift(`${why.replace(/\.$/, "")}.`);
  } else if (delivered.length === n) {
    icon = "check";
    color = "var(--green)";
    a =
      n === 1
        ? "Delivered to the recipient."
        : `Delivered to all ${people(n)}.`;
  } else if (delivered.length) {
    icon = "check";
    color = "var(--green)";
    a = `Delivered to ${delivered.length} of ${n} ${n === 1 ? "person" : "people"}.`;
    notes.unshift("The other emails are still on their way.");
  } else if (email.status === "queued") {
    a = "Waiting to be sent.";
  } else {
    a = `Sent to ${people(n)}.`;
    notes.unshift("Waiting for the receiving servers.");
  }

  if (deletedNote && !notes.length) notes.push(deletedNote);

  return { icon, color, a, b: notes.join(" ") };
}

// The loading state

function DetailSkeleton({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="flex flex-col gap-3 border-b border-line px-4 py-4 md:px-8 md:py-5">
        <SkeletonBlock className="h-3 w-40" />
        <SkeletonBlock className="h-7 w-72 max-w-full" />
        <SkeletonBlock className="h-3 w-96 max-w-full" />
      </div>
      <div className="border-b border-line bg-panel px-4 py-4 md:px-8 md:py-5">
        <SkeletonBlock className="h-6 w-2/3" />
      </div>
      <div className="grid md:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex flex-col border-r border-line">
          {Array.from({ length: 5 }, (_, i) => (
            <div
              key={i}
              className="flex h-[38px] items-center gap-3 px-4 md:px-8"
            >
              <SkeletonBlock className="h-2.5 w-14" />
              <SkeletonBlock className="size-2.5" />
              <SkeletonBlock className="h-2.5 w-2/5" />
            </div>
          ))}
          <SkeletonBlock className="mx-4 my-5 h-56 md:mx-8" />
        </div>
        <div>
          {Array.from({ length: 8 }, (_, i) => (
            <div
              key={i}
              className="flex h-[38px] items-center gap-3 border-b border-line px-4 md:px-8"
            >
              <SkeletonBlock className="h-2.5 w-16" />
              <SkeletonBlock className="h-2.5 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// The loaded screen

function Loaded({
  email,
  reload,
}: {
  email: EmailDetailData;
  reload: () => Promise<void>;
}) {
  const now = useNow();
  const { session } = useSession();
  const toast = useToast();
  const narrow = useNarrow();
  const bodyRes = useApi<EmailBody>(`/emails/${email.id}/body`);
  const [copied, copy] = useCopy();
  const [again, setAgain] = useState(false);
  const [picker, setPicker] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const scheduled = email.status === "scheduled";
  const bodyDeleted = !email.body_available && email.status !== "suppressed";
  const settings = useApi<Settings>(bodyDeleted ? "/settings" : null);
  const days = Number(settings.data?.settings.body_retention_days);

  const deletedNote = bodyDeleted
    ? `The body was deleted${days > 0 ? ` after ${days} days` : ""}. Metadata and events remain.`
    : null;

  const recipients = useMemo(() => recipientsOf(email), [email]);
  const [picked, setPicked] = useState<string | null>(null);

  const selected =
    recipients.find((r) => r.addr === picked) ??
    recipients.find((r) =>
      ["bounced", "failed", "complained"].includes(r.status),
    ) ??
    recipients[0];

  const story = storyOf(email, recipients, now, deletedNote);
  const sentAt = scheduled ? email.scheduled_at : email.sent_at;

  const sendAgain = async () => {
    setAgain(true);

    try {
      const r = await api<{ id: string }>(`/emails/${email.id}/resend`, {
        method: "POST",
      });

      navigate(`/emails/${r.id}`);
    } catch (err) {
      toast({ tone: "error", message: errorText(err) });
    } finally {
      setAgain(false);
    }
  };

  const copyCurl = () => {
    // The keys go in this order into the JSON. Empty fields stay out.
    const payload: JsonObject = {};
    payload.from = email.from;
    payload.to = email.to;

    if (email.cc?.length) payload.cc = email.cc;

    if (email.bcc?.length) payload.bcc = email.bcc;

    if (email.reply_to?.length) payload.reply_to = email.reply_to;
    payload.subject = email.subject;

    if (bodyRes.data?.html) payload.html = bodyRes.data.html;

    if (bodyRes.data?.text) payload.text = bodyRes.data.text;

    if (Object.keys(email.headers).length) payload.headers = email.headers;

    if (email.tags.length) payload.tags = email.tags;

    const json = JSON.stringify(payload, null, 2).replace(/'/g, "'\\''");
    copy(
      [
        `curl -X POST '${apiBase(session)}/emails' \\`,
        `  -H "Authorization: Bearer $FULLSEND_KEY" \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '${json}'`,
      ].join("\n"),
    );
  };

  const actionClass = "max-md:h-11";

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3.5 border-b border-line px-4 py-4 md:px-8 md:py-5">
        <div className="flex min-w-0 flex-col gap-2">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center font-mono text-[12.5px] text-fg3"
          >
            <Link href="/emails" className="text-fg2 no-underline">
              emails
            </Link>
            <Icon name="chevron-right" />
            <span className="truncate text-fg">{email.id}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="m-0 text-[22px] leading-[1.25] font-semibold tracking-[-0.02em] [overflow-wrap:anywhere] md:text-[28px]">
              {email.subject}
            </h1>
            <Badge status={email.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-[18px] gap-y-1 font-mono text-[12px] text-fg2">
            <span className="flex items-center [overflow-wrap:anywhere]">
              {email.id}
              <CopyButton text={email.id} label="Copy email id" />
            </span>
            <span title={utc(email.created_at)}>
              <span className="text-fg3">created</span>{" "}
              {when(email.created_at, now)}
            </span>
            <span title={sentAt ? utc(sentAt) : undefined}>
              <span className="text-fg3">{scheduled ? "sends" : "sent"}</span>{" "}
              {sentAt ? when(sentAt, now, !scheduled) : "not sent"}
            </span>
          </div>
        </div>
        <div className="relative flex flex-wrap gap-1.5">
          {scheduled ? (
            <>
              <Button
                icon="close"
                className={cx(actionClass, "text-red")}
                onClick={() => setCancelOpen(true)}
              >
                cancel
              </Button>
              <Button
                variant="primary"
                icon="calendar"
                className={actionClass}
                aria-expanded={picker}
                onClick={() => setPicker((v) => !v)}
              >
                reschedule
              </Button>
              {picker && !narrow && (
                <Popover onClose={() => setPicker(false)}>
                  <ReschedulePicker
                    now={now}
                    initial={email.scheduled_at}
                    id={email.id}
                    onDone={() => {
                      setPicker(false);
                      void reload();
                    }}
                  />
                </Popover>
              )}
              {narrow && (
                <Dialog
                  open={picker}
                  onClose={() => setPicker(false)}
                  title="Reschedule"
                  width={340}
                >
                  <ReschedulePicker
                    now={now}
                    initial={email.scheduled_at}
                    id={email.id}
                    onDone={() => {
                      setPicker(false);
                      void reload();
                    }}
                  />
                </Dialog>
              )}
              <ConfirmDialog
                open={cancelOpen}
                onClose={() => setCancelOpen(false)}
                title="Cancel this email?"
                body="The email will not be sent. You cannot undo this."
                action="cancel email"
                onConfirm={async () => {
                  await api(`/emails/${email.id}/cancel`, { method: "POST" });
                  await reload();
                }}
              />
            </>
          ) : (
            <>
              <Button
                icon={copied ? "check" : "code"}
                className={actionClass}
                disabled={bodyRes.loading || (!bodyRes.data && !bodyRes.error)}
                onClick={copyCurl}
              >
                {copied ? "copied" : "copy as curl"}
              </Button>
              <Button
                variant="primary"
                icon="reload"
                className={actionClass}
                busy={again}
                disabled={bodyDeleted || email.status === "suppressed"}
                onClick={() => void sendAgain()}
              >
                send again
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3 border-b border-line bg-panel px-4 py-3.5 md:px-8 md:py-[18px]">
        <span className="flex-none" style={{ color: story.color }}>
          <Icon name={story.icon} />
        </span>
        <p className="m-0 text-[17px] leading-[1.35] font-medium tracking-[-0.01em] md:text-[22px]">
          {story.a} <span className="text-fg2">{story.b}</span>
        </p>
      </div>

      <div className="grid flex-1 md:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col border-line md:border-r">
          <section className="border-b border-line">
            <div
              role="tablist"
              aria-label="Recipients"
              className="flex overflow-x-auto border-b border-line px-1 md:px-5"
            >
              {recipients.map((r) => (
                <button
                  key={r.addr}
                  type="button"
                  role="tab"
                  aria-selected={r === selected}
                  onClick={() => setPicked(r.addr)}
                  className={cx(
                    "flex h-12 flex-none items-center gap-2 border-0 bg-transparent px-3 font-mono text-[12.5px]",
                    r === selected
                      ? "text-fg shadow-[inset_0_-2px_0_var(--accent)]"
                      : "text-fg3 hover:text-fg",
                  )}
                >
                  {r.addr}
                  <Dot status={r.status} size={8} />
                </button>
              ))}
            </div>
            {selected && (
              <Timeline
                key={selected.addr}
                email={email}
                recipient={selected}
                now={now}
              />
            )}
          </section>

          <BodySection
            email={email}
            body={bodyRes}
            deleted={bodyDeleted}
            note={deletedNote}
          />

          <section>
            <div className="border-b border-line px-4 py-3 font-semibold md:px-8">
              Attachments
            </div>
            {email.attachments.length === 0 ? (
              <div className="px-4 py-3 text-fg2 md:px-8">No attachments.</div>
            ) : (
              email.attachments.map((a, i) => (
                <div
                  key={`${a.filename}-${i}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-2 md:px-8"
                >
                  <span className="text-fg2">
                    <Icon name="file" />
                  </span>
                  <span className="min-w-[140px] flex-1 font-mono text-[12.5px] [overflow-wrap:anywhere]">
                    {a.filename}
                  </span>
                  <span className="font-mono text-[12px] text-fg2">
                    {a.content_type} · {bytes(a.size)}
                  </span>
                  {email.body_available ? (
                    <a
                      href={`/api/emails/${email.id}/attachments/${i}`}
                      download
                      className="inline-flex h-9 items-center gap-1.5 border border-line2 pr-3 pl-2.5 font-mono text-[12px] font-medium text-fg no-underline max-md:h-11"
                    >
                      <Icon name="download" size={16} />
                      download
                    </a>
                  ) : (
                    <span className="inline-flex h-9 items-center gap-1.5 border border-line2 pr-3 pl-2.5 font-mono text-[12px] font-medium text-fg3 max-md:h-11">
                      <Icon name="download" size={16} />
                      deleted
                    </span>
                  )}
                </div>
              ))
            )}
          </section>
        </div>

        <aside className="min-w-0">
          <div className="border-b border-line px-4 py-3 font-semibold md:px-8">
            Details
          </div>
          <dl className="m-0">
            {metaRows(email).map((m) => (
              <div
                key={m.k}
                className="grid min-h-[38px] grid-cols-[110px_minmax(0,1fr)] items-center gap-3 border-b border-line px-4 py-1 md:px-8"
              >
                <dt className="text-[13px] text-fg3">{m.k}</dt>
                <dd className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  {m.v.map((v) => (
                    <span
                      key={v}
                      className="font-mono text-[12.5px] [overflow-wrap:anywhere]"
                    >
                      {v}
                    </span>
                  ))}
                  {m.copy && <CopyButton text={m.v[0]!} />}
                </dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-col gap-1.5 px-4 py-3.5 md:px-8">
            <span className="text-[13px] text-fg2">
              Each recipient has its own timeline. A bounce for one person does
              not affect the others.
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function metaRows(email: EmailDetailData) {
  const list = (v: string[] | null) => (v?.length ? v : ["none"]);
  const domain = address(email.from).split("@")[1];

  const rows: { k: string; v: string[]; copy?: boolean }[] = [
    { k: "From", v: [email.from] },
    { k: "To", v: email.to },
    { k: "Cc", v: list(email.cc) },
    { k: "Bcc", v: list(email.bcc) },
    { k: "Reply-to", v: list(email.reply_to) },
    { k: "API key", v: [email.api_key.name] },
    { k: "Domain", v: [domain ?? "none"] },
    {
      k: "Tags",
      v: email.tags.length
        ? email.tags.map((t) => (t.value ? `${t.name}=${t.value}` : t.name))
        : ["none"],
    },
    { k: "Size", v: [bytes(email.size)] },
    {
      k: "CF message",
      v: [email.message_id ?? "none yet"],
      copy: Boolean(email.message_id),
    },
  ];

  return rows;
}

// The timeline of one recipient

const OPEN_BY_DEFAULT = new Set([
  "bounced",
  "failed",
  "complained",
  "suppressed",
]);

function Timeline({
  email,
  recipient,
  now,
}: {
  email: EmailDetailData;
  recipient: Recipient;
  now: number;
}) {
  // The events that the owner opened or closed against the default.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const events = recipient.events;

  if (!events.length) {
    return (
      <p className="m-0 px-4 py-4 text-fg2 md:px-8">
        No events for this address yet.
      </p>
    );
  }

  return (
    <ol className="m-0 list-none py-1.5 pl-0">
      {events.map((e, i) => {
        const rows = detailRows(e.data);
        const more = rows.length > 0;
        const open = more && OPEN_BY_DEFAULT.has(e.type) !== toggled.has(e.id);
        const color = `var(--${toneName(e.type)})`;
        const last = i === events.length - 1;

        const head = (
          <>
            <span
              className="font-mono text-[12.5px] font-medium"
              style={{ color: e.bot ? "var(--fg3)" : color }}
            >
              {e.type}
            </span>
            <span
              className={cx("text-[13.5px]", e.bot ? "text-fg3" : "text-fg2")}
            >
              {plainOf(e, email, recipient, now)}
            </span>
            {e.bot && (
              <span className="flex items-center gap-0.5 border border-line2 pr-1.5 pl-0.5 font-mono text-[11.5px] text-fg2">
                <Icon name="android" />
                bot · {e.bot}
              </span>
            )}
            {more && (
              <span className="ml-auto text-fg3">
                <Icon name={open ? "chevron-down" : "chevron-right"} />
              </span>
            )}
          </>
        );

        return (
          <li
            key={e.id}
            className="grid grid-cols-[62px_12px_minmax(0,1fr)] gap-3 px-4 py-1.5 md:grid-cols-[76px_12px_minmax(0,1fr)] md:px-8"
          >
            <span
              title={utc(e.created_at)}
              className="font-mono text-[12px] leading-6 text-fg3"
            >
              {clock(e.created_at)}
            </span>
            <span className="relative flex justify-center">
              <span
                className={cx(
                  "relative z-[1] mt-[7px] size-2.5",
                  e.bot && "opacity-50",
                )}
                style={{ background: color }}
              />
              {!last && (
                <span className="absolute top-[17px] -bottom-[13px] w-px bg-line2" />
              )}
            </span>
            <div className="flex min-w-0 flex-col gap-1.5">
              {more ? (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setToggled((s) => {
                      const next = new Set(s);

                      if (!next.delete(e.id)) next.add(e.id);

                      return next;
                    })
                  }
                  className="flex min-h-6 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-0 bg-transparent p-0 text-left text-fg max-md:min-h-11"
                >
                  {head}
                </button>
              ) : (
                <span className="flex min-h-6 flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  {head}
                </span>
              )}
              {open && (
                <div className="border border-line bg-panel font-mono text-[12px] leading-[19px]">
                  {rows.map((d) => (
                    <div
                      key={d.k}
                      className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 border-b border-line px-2.5 py-1.5 last:border-b-0"
                    >
                      <span className="text-fg3">{d.k}</span>
                      <span className="[overflow-wrap:anywhere]">{d.v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const TONES = new Map([
  ["queued", "gray"],
  ["scheduled", "blue"],
  ["sent", "blue"],
  ["delivered", "green"],
  ["delivery_delayed", "amber"],
  ["bounced", "red"],
  ["complained", "red"],
  ["opened", "cyan"],
  ["clicked", "cyan"],
  ["failed", "red"],
  ["canceled", "gray"],
  ["suppressed", "amber"],
]);

const toneName = (type: string) => TONES.get(type) ?? "gray";

// The body

type PreviewTab = "html" | "text" | "headers";

function BodySection({
  email,
  body,
  deleted,
  note,
}: {
  email: EmailDetailData;
  body: ReturnType<typeof useApi<EmailBody>>;
  deleted: boolean;
  note: string | null;
}) {
  const [tab, setTab] = useState<PreviewTab>("html");
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");

  const tabs: { value: PreviewTab; label: string }[] = [
    { value: "html", label: "html" },
    { value: "text", label: "plain text" },
    { value: "headers", label: "raw headers" },
  ];

  const data = body.data;
  const empty = deleted || (data && !data.html && !data.text);

  const gone = (
    <div className="flex flex-col items-start gap-1.5 px-4 py-9 md:px-8">
      <div className="flex items-center gap-2.5">
        <span className="flex-none text-fg3">
          <Icon name={email.status === "suppressed" ? "mail-off" : "archive"} />
        </span>
        <span className="text-[16px] font-semibold">
          {email.status === "suppressed"
            ? "No body was stored."
            : (note?.split(". ")[0]?.replace(/\.$/, "") ??
                "The body is no longer stored") + "."}
        </span>
      </div>
      <span className="text-fg2">
        {email.status === "suppressed"
          ? "The email was not sent, so fullsend kept no body."
          : "Metadata and events remain. Retention is set in Settings."}
      </span>
    </div>
  );

  let content;

  if (body.error) {
    content = (
      <div className="px-4 py-5 md:px-8">
        <Notice
          tone="red"
          title="Could not load the body"
          action={
            <Button size="sm" icon="reload" onClick={() => void body.reload()}>
              retry
            </Button>
          }
        >
          {errorText(body.error)}
        </Notice>
      </div>
    );
  } else if (!data) {
    content = (
      <div className="px-4 py-5 md:px-8">
        <SkeletonBlock className="h-56" />
      </div>
    );
  } else if (tab === "headers") {
    content = (
      <div className="m-4 border border-line bg-panel font-mono text-[12px] leading-[19px] md:mx-8">
        {Object.entries(data.headers).map(([k, v]) => (
          <div
            key={k}
            className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 border-b border-line px-2.5 py-1.5 last:border-b-0"
          >
            <span className="text-fg3">{k}</span>
            <span className="[overflow-wrap:anywhere]">{v}</span>
          </div>
        ))}
      </div>
    );
  } else if (empty) {
    content = gone;
  } else if (tab === "text") {
    content = data.text ? (
      <pre className="m-0 px-4 py-4 font-mono text-[12.5px] leading-5 break-words whitespace-pre-wrap md:px-8">
        {data.text}
      </pre>
    ) : (
      <p className="m-0 px-4 py-5 text-fg2 md:px-8">
        This email has no plain text part.
      </p>
    );
  } else if (data.html) {
    const px = width === "desktop" ? 600 : 375;
    content = (
      <div className="bg-panel px-4 py-5 md:px-8">
        <iframe
          title="Email preview"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={previewDoc(data.html)}
          className="mx-auto block h-[480px] w-full border-0 bg-white shadow-[0_0_0_1px_var(--line)]"
          style={{ maxWidth: px }}
        />
        <div className="mt-2 text-center font-mono text-[11px] text-fg3">
          sandboxed frame · scripts and remote images blocked · {px} px
        </div>
      </div>
    );
  } else {
    content = (
      <p className="m-0 px-4 py-5 text-fg2 md:px-8">
        This email has no HTML part.
      </p>
    );
  }

  return (
    <section className="border-b border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-1 md:px-5">
        <div role="tablist" aria-label="Body" className="flex">
          {tabs.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={tab === t.value}
              onClick={() => setTab(t.value)}
              className={cx(
                "h-11 border-0 bg-transparent px-3 font-mono text-[12.5px] font-medium",
                tab === t.value
                  ? "text-fg shadow-[inset_0_-2px_0_var(--accent)]"
                  : "text-fg3 hover:text-fg",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "html" && !empty && data?.html && (
          <div
            role="radiogroup"
            aria-label="Preview width"
            className="flex gap-0.5 pr-3 md:pr-0"
          >
            {(
              [
                ["desktop", "Desktop", "device-laptop"],
                ["mobile", "Mobile", "device-phone"],
              ] as const
            ).map(([value, label, icon]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={width === value}
                aria-label={label}
                onClick={() => setWidth(value)}
                className={cx(
                  "grid size-9 place-items-center border bg-transparent max-md:size-11",
                  width === value
                    ? "border-fg2 text-fg"
                    : "border-line2 text-fg3",
                )}
              >
                <Icon name={icon} size={16} />
              </button>
            ))}
          </div>
        )}
      </div>
      {content}
    </section>
  );
}

// The frame blocks scripts, remote images and remote styles. A remote
// image would make an open event for the owner's own view.
function previewDoc(html: string): string {
  const csp =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">${html}`;
}

// The reschedule control

function Popover({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const el = ref.current;

      const inside = e.target instanceof Node && el?.contains(e.target);

      if (el && !inside) onClose();
    };

    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);

    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Reschedule"
      className="absolute top-[46px] right-0 z-[3] w-[300px] border border-line2 bg-bg shadow-[0_20px_50px_var(--shadow)]"
    >
      {children}
    </div>
  );
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function ReschedulePicker({
  now,
  initial,
  id,
  onDone,
}: {
  now: number;
  initial: string | null;
  id: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const start = new Date(initial ?? now);

  const [view, setView] = useState({
    y: start.getUTCFullYear(),
    m: start.getUTCMonth(),
  });

  const [day, setDay] = useState<{ y: number; m: number; d: number } | null>(
    initial
      ? {
          y: start.getUTCFullYear(),
          m: start.getUTCMonth(),
          d: start.getUTCDate(),
        }
      : null,
  );

  const [time, setTime] = useState(
    initial
      ? `${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())}`
      : "09:00",
  );

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const offset = (new Date(utcMs(view.y, view.m, 1)).getUTCDay() + 6) % 7;
  const count = new Date(utcMs(view.y, view.m + 1, 0)).getUTCDate();

  const cells = Array.from(
    { length: Math.ceil((offset + count) / 7) * 7 },
    (_, i) => i - offset + 1,
  );

  const shift = (by: number) =>
    setView((v) => {
      const d = new Date(Date.UTC(v.y, v.m + by, 1));

      return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    });

  const save = async () => {
    let value = text.trim();

    if (!value) {
      const t = TIME.exec(time.trim());

      if (!day || !t) {
        setError("Pick a day and write the time as HH:MM.");

        return;
      }

      value = new Date(
        Date.UTC(day.y, day.m, day.d, Number(t[1]), Number(t[2])),
      ).toISOString();
    }

    setBusy(true);
    setError(null);

    try {
      await api(`/emails/${id}`, {
        method: "PATCH",
        body: { scheduled_at: value },
      });
      toast({ tone: "success", message: "Email rescheduled." });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const arrow =
    "grid size-8 place-items-center border-0 bg-transparent text-fg2 hover:text-fg max-md:size-11";

  return (
    <div className="text-fg">
      <div className="flex items-center justify-between border-b border-line p-1 font-mono text-[12.5px] font-semibold">
        <button
          type="button"
          aria-label="Previous month"
          className={arrow}
          onClick={() => shift(-1)}
        >
          <Icon name="chevron-left" size={16} />
        </button>
        {MONTH_NAMES[view.m]} {view.y}
        <button
          type="button"
          aria-label="Next month"
          className={arrow}
          onClick={() => shift(1)}
        >
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 p-2 text-center font-mono text-[12px]">
        {cells.map((n, i) => {
          if (n < 1 || n > count) return <span key={i} />;
          const past = utcMs(view.y, view.m, n, 23, 59) < now;
          const on = day?.y === view.y && day.m === view.m && day.d === n;

          return (
            <button
              key={i}
              type="button"
              disabled={past}
              aria-pressed={on}
              onClick={() => setDay({ y: view.y, m: view.m, d: n })}
              className={cx(
                "h-8 border-0 max-md:h-10",
                on
                  ? "bg-accent font-semibold text-accent-ink"
                  : "bg-transparent text-fg hover:bg-hover",
                past && "text-fg3 hover:bg-transparent",
              )}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 border-t border-line p-2">
        <div className="flex items-center gap-1.5">
          <span className="text-fg3">
            <Icon name="clock" />
          </span>
          <Input
            aria-label="Time, UTC"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            placeholder="09:00"
            className="flex-1"
          />
          <span className="font-mono text-[12px] text-fg2">UTC</span>
        </div>
        <Input
          aria-label="Or write the time in words"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="or write it, for example in 1 hour"
        />
        {error && (
          <Notice tone="red" className="text-[13px]">
            {error}
          </Notice>
        )}
        <Button
          variant="primary"
          busy={busy}
          onClick={() => void save()}
          className="self-end max-md:h-11"
        >
          save
        </Button>
      </div>
    </div>
  );
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
