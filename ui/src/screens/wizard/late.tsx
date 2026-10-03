import { useEffect, useState } from "react";
import {
  api,
  type EmailDetail,
  type EmailEvent,
  type HostnameResult,
  type Hostnames,
} from "../../api";
import {
  Badge,
  Button,
  CodeBlock,
  Dialog,
  ErrorState,
  Field,
  Icon,
  Input,
  Notice,
  SecretReveal,
  SkeletonBlock,
  errorText,
  useToast,
} from "../../components/ui";
import { clock, plainReason } from "../../lib/format";
import { useApi, useNow, usePoll } from "../../lib/hooks";
import { pick } from "../../lib/json";
import { Link, navigate } from "../../lib/router";
import { apiBase, useSession } from "../../session";
import { Hint, type Flow, Mono, NeedDomain, Rows, StepFrame } from "./parts";

// Steps 5 to 8: the hostnames, the first key, the test email, the end.

type HostKey = "api_hostname" | "tracking_hostname";

const HOSTS: {
  key: HostKey;
  icon: string;
  label: string;
  sub: string;
  use: string;
}[] = [
  {
    key: "api_hostname",
    icon: "code",
    label: "API hostname",
    sub: "email",
    use: "The base URL for your SDK.",
  },
  {
    key: "tracking_hostname",
    icon: "link",
    label: "Tracking hostname",
    sub: "t",
    use: "Serves the open-tracking pixel and the click redirects.",
  },
];

// The zone guess of a domain: its last two labels.
const rootOf = (name: string) => name.split(".").slice(-2).join(".");

// Step 5: the hostnames

export function StepHostnames({ flow }: { flow: Flow }) {
  const cur = useApi<Hostnames>("/hostnames");
  const [edit, setEdit] = useState<Partial<Record<HostKey, string>>>({});

  const [results, setResults] = useState<
    Partial<Record<HostKey, HostnameResult>>
  >({});

  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const root = flow.domain ? rootOf(flow.domain.name) : "";

  const value = (h: (typeof HOSTS)[number]) =>
    edit[h.key] ??
    cur.data?.[h.key].hostname ??
    (root ? `${h.sub}.${root}` : "");

  // A hostname counts as attached after an attach, or when Cloudflare
  // already lists it.
  const attached = (h: (typeof HOSTS)[number]) => {
    const v = value(h).trim().toLowerCase();
    const r = results[h.key];

    if (r) return r.hostname === v && r.status !== "error";
    const c = cur.data?.[h.key];

    return Boolean(c && c.hostname === v && c.status === "active");
  };

  const all = HOSTS.every(attached);

  const attach = async () => {
    setBusy(true);
    setError(null);

    try {
      const res = await api<Record<HostKey, HostnameResult | undefined>>(
        "/hostnames",
        {
          method: "POST",
          body: {
            api_hostname: value(HOSTS[0]!).trim(),
            tracking_hostname: value(HOSTS[1]!).trim(),
          },
        },
      );

      setResults({
        api_hostname: res.api_hostname,
        tracking_hostname: res.tracking_hostname,
      });
      flow.setHostnames({
        api:
          res.api_hostname && res.api_hostname.status !== "error"
            ? res.api_hostname.hostname
            : null,
        tracking:
          res.tracking_hostname && res.tracking_hostname.status !== "error"
            ? res.tracking_hostname.hostname
            : null,
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setChecking(true);

    try {
      await cur.reload();
    } finally {
      setChecking(false);
    }
  };

  return (
    <StepFrame
      narrow={flow.narrow}
      footer={{
        back: () => flow.go(4),
        skip: { label: "skip this step", onClick: () => flow.go(6) },
        second: {
          label: "check again",
          icon: "reload",
          busy: checking,
          onClick: recheck,
        },
        primary: {
          label: all ? "continue" : "attach hostnames",
          busy,
          disabled: !cur.data && !all,
          onClick: all ? () => flow.go(6) : attach,
        },
      }}
    >
      {cur.error ? (
        <ErrorState
          error={cur.error}
          title="Could not read the hostnames"
          onRetry={() => void cur.reload()}
          className="!px-0 !py-4"
        />
      ) : !cur.data ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <SkeletonBlock className="h-24" />
          <SkeletonBlock className="h-24" />
        </div>
      ) : (
        <Rows>
          {HOSTS.map((h) => {
            const r = results[h.key];
            const c = cur.data?.[h.key];

            const status = busy
              ? "attaching"
              : r
                ? r.status
                : attached(h)
                  ? "active"
                  : (c?.status ?? "unset");

            return (
              <div
                key={h.key}
                className="flex flex-col gap-2 border-b border-line py-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-3">
                    <span className="grid size-11 shrink-0 place-items-center bg-raised">
                      <Icon name={h.icon} />
                    </span>
                    <span className="text-[13px] text-fg2">{h.label}</span>
                  </span>
                  <Badge
                    status={status}
                    tone={status === "attaching" ? "blue" : undefined}
                    hollow={status === "attaching" ? true : undefined}
                  />
                </div>
                <Field
                  label={<span className="sr-only">{h.label}</span>}
                  error={r?.status === "error" ? r.error : undefined}
                >
                  <Input
                    value={value(h)}
                    onChange={(e) =>
                      setEdit({ ...edit, [h.key]: e.target.value })
                    }
                    spellCheck={false}
                    autoCapitalize="none"
                    className="h-10"
                  />
                </Field>
                <span className="text-[13.5px] text-fg2">
                  {r?.status === "manual" ? r.error : h.use}
                </span>
              </div>
            );
          })}
        </Rows>
      )}
      {error && (
        <Notice tone="red" title="Could not attach the hostnames">
          {error}
        </Notice>
      )}
    </StepFrame>
  );
}

// Step 6: the first API key

interface Made {
  name: string;
  prefix: string;
  token: string;
}

export function StepKey({ flow }: { flow: Flow }) {
  const [name, setName] = useState(flow.key?.name ?? "production");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The secret lives here only. The dialog closes it.
  const [secret, setSecret] = useState<Made | null>(null);

  const make = async () => {
    setBusy(true);
    setError(null);

    try {
      const k = await api<{ name: string; prefix: string; token: string }>(
        "/api-keys",
        {
          method: "POST",
          body: { name: name.trim(), permission: "full_access" },
        },
      );

      flow.setKey({ name: k.name, prefix: k.prefix });
      setSecret({ name: k.name, prefix: k.prefix, token: k.token });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepFrame
      narrow={flow.narrow}
      footer={{
        back: () => flow.go(5),
        primary: flow.key
          ? { onClick: () => flow.go(7) }
          : { label: "make key", disabled: !name.trim(), busy, onClick: make },
      }}
    >
      <Field label="Key name" error={error}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={Boolean(flow.key)}
          className="h-10"
        />
      </Field>
      {flow.key ? (
        <Notice tone="green" title={`Key ${flow.key.name} is made`}>
          The key starts with <Mono>{flow.key.prefix}</Mono>. fullsend stores a
          hash and cannot show it again.
        </Notice>
      ) : (
        <Hint>
          Full access. fullsend stores a hash of the key. Put it in your app as{" "}
          <Mono>RESEND_API_KEY</Mono>.
        </Hint>
      )}
      <Dialog
        open={Boolean(secret)}
        onClose={() => undefined}
        locked
        title="Copy your API key"
        width={520}
      >
        {secret && (
          <div className="flex flex-col gap-4">
            <SecretReveal secret={secret.token} />
            <span>
              Full access, stored as a hash. Put it in your app as{" "}
              <Mono>RESEND_API_KEY</Mono>.
            </span>
            <div className="-mx-5 -mb-5 flex justify-end border-t border-line p-5">
              <Button variant="primary" onClick={() => setSecret(null)}>
                I saved it
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </StepFrame>
  );
}

// Step 7: the test email

const DONE = new Set([
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
]);

interface Row {
  time: string;
  type: string;
  note: string;
  detail?: string;
  state: "done" | "wait";
  tone: "gray" | "blue" | "green" | "amber" | "red" | "cyan";
}

const NOTE = new Map([
  ["queued", "accepted"],
  ["sent", "handed to Cloudflare"],
  ["delivered", "delivered to the receiving server"],
  ["delivery_delayed", "the receiving server delayed it"],
  ["opened", "opened"],
  ["clicked", "clicked"],
]);

function rowOf(ev: EmailEvent, email: EmailDetail): Row {
  const reply = pick(ev.data, "bounce", "reason") ?? email.error ?? undefined;

  const tone =
    ev.type === "delivered"
      ? "green"
      : ev.type === "bounced" ||
          ev.type === "complained" ||
          ev.type === "failed"
        ? "red"
        : ev.type === "delivery_delayed"
          ? "amber"
          : ev.type === "sent"
            ? "blue"
            : ev.type === "opened" || ev.type === "clicked"
              ? "cyan"
              : "gray";

  const failed = tone === "red";

  return {
    time: clock(ev.created_at),
    type: ev.type,
    note: failed
      ? (plainReason(reply) ?? "The email did not arrive")
      : (NOTE.get(ev.type) ?? ev.type),
    detail: failed ? reply : undefined,
    state: "done",
    tone,
  };
}

export function StepTest({ flow }: { flow: Flow }) {
  const { session } = useSession();

  const [to, setTo] = useState(
    session.identity?.includes("@") ? session.identity : "",
  );

  const [sent, setSent] = useState<{ id: string; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const domain = flow.domain;

  const send = async () => {
    if (!domain) return;
    setBusy(true);
    setError(null);

    try {
      const r = await api<{ id: string }>("/emails", {
        method: "POST",
        body: {
          from: `hello@${domain.name}`,
          to: [to.trim()],
          subject: "fullsend test email",
          text: "This is a test email from the fullsend setup.",
          html: "<p>This is a test email from the fullsend setup.</p>",
        },
      });

      setSent({ id: r.id, at: Date.now() });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepFrame
      narrow={flow.narrow}
      footer={{
        back: () => flow.go(6),
        skip: { label: "skip test", onClick: () => flow.go(8) },
        primary: { disabled: !flow.tested, onClick: () => flow.go(8) },
      }}
    >
      {!domain ? (
        <NeedDomain go={flow.go} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Field
              label={<span className="sr-only">Send the test to</span>}
              error={error}
              className="min-w-[200px] flex-1"
            >
              <Input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="you@example.com"
                disabled={busy || Boolean(sent)}
                className="h-10"
              />
            </Field>
            <Button
              variant="primary"
              icon="mail"
              busy={busy}
              disabled={!to.trim() || Boolean(sent)}
              onClick={send}
              className="h-10 self-start"
            >
              {sent ? "sent" : "send test"}
            </Button>
          </div>
          {sent && (
            <Live
              key={sent.id}
              id={sent.id}
              at={sent.at}
              onDelivered={() => flow.setTested(true)}
              onRetry={() => {
                setSent(null);
                setTo("");
              }}
            />
          )}
        </>
      )}
    </StepFrame>
  );
}

// The live timeline of one test email. It polls every 2 s while the tab is
// visible, until the email ends or 30 polls pass.
function Live({
  id,
  at,
  onDelivered,
  onRetry,
}: {
  id: string;
  at: number;
  onDelivered: () => void;
  onRetry: () => void;
}) {
  const mail = useApi<EmailDetail>(`/emails/${id}`);
  const now = useNow(1000);
  const email = mail.data;
  const end = email?.events.find((e) => DONE.has(e.type));
  const finished = Boolean(end) || (email ? DONE.has(email.status) : false);
  const poll = usePoll(mail.reload, finished ? null : 2000, 30);

  const delivered = email?.events.some((e) => e.type === "delivered") ?? false;
  useEffect(() => {
    if (delivered) onDelivered();
  }, [delivered, onDelivered]);

  if (mail.error && !email)
    return (
      <ErrorState
        error={mail.error}
        title="Could not read the test email"
        onRetry={() => void mail.reload()}
        className="!px-0 !py-4"
      />
    );

  if (!email) return <SkeletonBlock className="h-24" />;

  const rows: Row[] = [];

  if (!email.events.some((e) => e.type === "queued"))
    rows.push({
      time: clock(email.created_at),
      type: "queued",
      note: `accepted · ${id.slice(0, 8)}`,
      state: "done",
      tone: "gray",
    });

  for (const ev of email.events) rows.push(rowOf(ev, email));
  const failedNow = email.status === "failed" && !end;

  if (failedNow)
    rows.push({
      time: clock(email.last_event_at),
      type: "failed",
      note: plainReason(email.error) ?? "The email did not send",
      detail: email.error ?? undefined,
      state: "done",
      tone: "red",
    });
  const slow = now - at > 60_000;

  if (!finished && !failedNow)
    rows.push({
      time: "waiting",
      type: "delivered",
      note: poll.stopped
        ? "Stopped. The email has no delivery event yet."
        : slow
          ? "Still waiting. Check delivery events in step 4."
          : "Waiting for the delivery event. Usually under 10 s.",
      state: "wait",
      tone: "gray",
    });
  const bad = rows.some((r) => r.state === "done" && r.tone === "red");

  return (
    <div className="flex flex-col gap-3">
      <div role="status" aria-live="polite">
        <Rows>
          {rows.map((r, i) => (
            <div
              key={`${r.type}-${i}`}
              className="grid grid-cols-[72px_12px_minmax(0,1fr)] items-start gap-3 border-b border-line py-2.5"
            >
              <span className="font-mono text-[12px] leading-[22px] text-fg3">
                {r.time}
              </span>
              <span
                className="mt-1.5 size-2.5"
                style={{
                  background:
                    r.state === "wait" ? "transparent" : `var(--${r.tone})`,
                  boxShadow: `inset 0 0 0 2px ${r.state === "wait" ? "var(--line2)" : `var(--${r.tone})`}`,
                }}
              />
              <span className="flex flex-col gap-0.5">
                <span className="flex flex-wrap gap-x-2.5 gap-y-1">
                  <span
                    className="font-mono text-[12.5px] font-medium"
                    style={{
                      color:
                        r.state === "wait"
                          ? "var(--fg3)"
                          : `var(--${r.tone === "gray" ? "fg" : r.tone})`,
                    }}
                  >
                    {r.type}
                  </span>
                  <span className="text-fg2">{r.note}</span>
                  {r.state === "wait" && slow && (
                    <Link href="/setup/4" className="text-fg">
                      check delivery events
                    </Link>
                  )}
                </span>
                {r.detail && (
                  <code className="font-mono text-[12px] text-fg3 [overflow-wrap:anywhere]">
                    {r.detail}
                  </code>
                )}
              </span>
            </div>
          ))}
        </Rows>
      </div>
      {(bad || (poll.stopped && !finished)) && (
        <div className="flex flex-wrap gap-2">
          {poll.stopped && !finished && (
            <Button
              icon="reload"
              onClick={() => {
                poll.restart();
                void mail.reload();
              }}
            >
              try again
            </Button>
          )}
          {bad && (
            <Button icon="reload" onClick={onRetry}>
              try another address
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Step 8: done

export function StepDone({ flow }: { flow: Flow }) {
  const { session, reload } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const d = flow.domain;

  const base = flow.hostnames.api
    ? `https://${flow.hostnames.api}`
    : apiBase(session);

  const from = `hello@${d?.name ?? "example.com"}`;

  const done = [
    flow.tokenSet && "token",
    d?.status === "verified" && `${d.name} verified`,
    d?.event_subscription.status === "active" && "events",
    flow.hostnames.api &&
      [flow.hostnames.api, flow.hostnames.tracking].filter(Boolean).join(", "),
    flow.key && `key ${flow.key.name}`,
    flow.tested && "test delivered",
  ].filter((x): x is string => Boolean(x));

  const finish = async (to: string) => {
    setBusy(to);

    try {
      await api("/settings", {
        method: "PATCH",
        body: { setup_completed: "true" },
      });
      await reload();
      navigate(to);
    } catch (err) {
      toast({ tone: "error", message: errorText(err) });
      setBusy(null);
    }
  };

  return (
    <StepFrame narrow={flow.narrow}>
      {done.length > 0 && (
        <div className="flex flex-wrap gap-x-4.5 gap-y-1.5 border-y border-line py-3 font-mono text-[12.5px]">
          {done.map((x) => (
            <span key={x} className="flex items-center gap-0.5">
              <Icon name="check" className="text-green" />
              {x}
            </span>
          ))}
        </div>
      )}
      <CodeBlock
        tabs={[
          {
            label: "resend sdk",
            code: `import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY, {
  baseUrl: '${base}',
});
await resend.emails.send({
  from: '${from}',
  to: 'you@example.com',
  subject: 'Your sign-in link',
  html: '<p>Hello</p>',
});`,
          },
          {
            label: "service binding",
            code: `// wrangler.jsonc of your Worker
// "services": [{ "binding": "FULLSEND", "service": "fullsend", "entrypoint": "FullsendRpc" }]
const { data, error } = await env.FULLSEND.sendEmail({
  from: '${from}',
  to: 'you@example.com',
  subject: 'Your sign-in link',
  html: '<p>Hello</p>',
});`,
          },
          {
            label: "curl",
            code: `curl -X POST '${base}/emails' \\
  -H "Authorization: Bearer $RESEND_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"from":"${from}","to":"you@example.com","subject":"Your sign-in link","html":"<p>Hello</p>"}'`,
          },
        ]}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon="mail"
          busy={busy === "/emails"}
          disabled={Boolean(busy)}
          onClick={() => finish("/emails")}
          className="h-10"
        >
          go to emails
        </Button>
        <Button
          icon="book-open"
          busy={busy === "/docs"}
          disabled={Boolean(busy)}
          onClick={() => finish("/docs")}
          className="h-10"
        >
          read the docs
        </Button>
        <Button
          variant="ghost"
          busy={busy === "/"}
          disabled={Boolean(busy)}
          onClick={() => finish("/")}
          className="h-10"
        >
          open the dashboard
        </Button>
      </div>
    </StepFrame>
  );
}
