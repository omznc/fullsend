import { useState } from "react";
import { api, ApiRequestError, type Domain, type DomainRecord } from "../api";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  errorText,
  ErrorState,
  Icon,
  Notice,
  PageHeader,
  RelTime,
  SkeletonBlock,
  TableHead,
  TableRow,
  Toggle,
  useToast,
} from "../components/ui";
import { useApi, useTitle } from "../lib/hooks";
import { navigate } from "../lib/router";
import { useSession } from "../session";
import { useVerifyPoll, VerifyBanner } from "./domains/verify";

const COLS = "70px 230px minmax(0,1fr) 70px 70px 190px";

const HEAD = ["type", "name", "value", "priority", "ttl", "status"];

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six"];

// The text at the top of a domain: a title and one sentence.
interface Headline {
  title: string;
  text: string;
  ok: boolean;
}

function headline(d: Domain): Headline {
  if (d.status === "verified")
    return {
      title: "This domain can send.",
      text: "All DNS records are verified.",
      ok: true,
    };
  const open = d.records.filter((r) => r.status !== "verified").length;
  const word = NUMBER_WORDS[open] ?? String(open);

  return {
    title:
      open === 0
        ? "Cloudflare has not verified this domain yet."
        : `${word} ${open === 1 ? "record" : "records"} left.`,
    text: "Add the records below and this domain can send. Verify now asks Cloudflare to add missing records, then checks again.",
    ok: false,
  };
}

export function DomainDetail({ id }: { id: string }) {
  const { data, error, loading, reload, setData } = useApi<Domain>(
    `/domains/${encodeURIComponent(id)}`,
  );

  useTitle(data?.name ?? "Domain");
  const poll = useVerifyPoll(id, setData);

  if (error && !data) {
    const missing = error instanceof ApiRequestError && error.status === 404;

    return (
      <>
        <PageHeader
          title="Domain"
          back={{ href: "/domains", label: "domains" }}
        />
        <ErrorState
          error={error}
          title={missing ? "Domain not found" : "Could not load this domain"}
          onRetry={missing ? undefined : () => void reload()}
        />
      </>
    );
  }

  if (!data) {
    return (
      <div aria-busy={loading || undefined} aria-label="Loading">
        <PageHeader
          title={<SkeletonBlock className="h-7 w-64" />}
          back={{ href: "/domains", label: "domains" }}
        />
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="flex h-[52px] items-center border-b border-line px-4 md:px-8"
          >
            <SkeletonBlock className="h-2.5 w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  return <Loaded domain={data} poll={poll} onDomain={setData} />;
}

function Loaded({
  domain,
  poll,
  onDomain,
}: {
  domain: Domain;
  poll: ReturnType<typeof useVerifyPoll>;
  onDomain: (d: Domain) => void;
}) {
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const canVerify = domain.cf_zone_id !== null;
  const head = headline(domain);

  return (
    <>
      <PageHeader
        back={{ href: "/domains", label: "domains" }}
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono tracking-[-0.03em]">{domain.name}</span>
            <Badge status={domain.status} />
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-1 font-mono text-[12px] text-fg2">
            <Icon name="clock" className="text-fg3" />
            last checked <RelTime at={domain.checked_at} />
            {poll.active && <span> · checking every 10 s for 5 minutes</span>}
          </span>
        }
        actions={
          canVerify && (
            <Button
              variant="primary"
              icon="reload"
              busy={poll.busy}
              onClick={poll.start}
            >
              verify now
            </Button>
          )
        }
      />

      {canVerify && (poll.active || poll.stopped) && (
        <div className="px-4 pb-4 md:px-8">
          <VerifyBanner records={domain.records} poll={poll} />
        </div>
      )}
      {!poll.active && !poll.stopped && poll.error && (
        <div className="px-4 pb-4 md:px-8">
          <Notice tone="red">{poll.error}</Notice>
        </div>
      )}

      <div className="flex items-start gap-3 border-y border-line bg-panel px-4 py-4 md:px-8">
        <Icon
          name={head.ok ? "check" : "warning-box"}
          className={head.ok ? "text-green" : "text-amber"}
        />
        <p className="m-0 text-[20px] leading-[28px] font-medium tracking-[-0.01em] md:text-[22px] md:leading-[30px]">
          {head.title} <span className="text-fg2">{head.text}</span>
        </p>
      </div>

      <section className="border-b border-line">
        <h2 className="m-0 border-b border-line px-4 py-3 text-[14px] font-semibold md:px-8">
          DNS records
        </h2>
        {domain.records.length === 0 ? (
          <p className="m-0 px-4 py-4 text-fg2 md:px-8">
            fullsend has no DNS records for this domain.{" "}
            {canVerify
              ? "Use verify now to read them from Cloudflare."
              : "It was imported without a Cloudflare token, so fullsend trusts that the records are set."}
          </p>
        ) : (
          <div role="table" aria-label="DNS records">
            <TableHead template={COLS} columns={HEAD} className="border-t-0" />
            {domain.records.map((r, i) => (
              <RecordRow key={`${r.type}${r.name}${i}`} r={r} />
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 border-b border-line md:grid-cols-3">
        <Tracking domain={domain} onDomain={onDomain} />
        <Events domain={domain} onDomain={onDomain} />
        <section className="flex flex-col gap-2.5 px-4 py-4 md:px-8 md:py-[18px]">
          <span className="text-[15px] font-semibold text-red">
            Danger zone
          </span>
          <span className="font-semibold">Delete this domain</span>
          <span className="text-[13.5px] text-fg2">
            Email from {domain.name} stops. Past emails and events stay. You
            confirm by typing the domain name.
          </span>
          <Button
            variant="danger"
            icon="trash"
            className="self-start"
            onClick={() => setDeleting(true)}
          >
            delete domain
          </Button>
        </section>
      </div>

      <ConfirmDialog
        open={deleting}
        title={`Delete ${domain.name}?`}
        body="Email from this domain stops. Past emails and events stay."
        action="delete domain"
        confirmText={domain.name}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await api(`/domains/${encodeURIComponent(domain.id)}`, {
            method: "DELETE",
            body: { confirm: domain.name },
          });
          toast({ tone: "success", message: `${domain.name} is deleted.` });
          navigate("/domains");
        }}
      />
    </>
  );
}

function RecordRow({ r }: { r: DomainRecord }) {
  const ok = r.status === "verified";

  return (
    <TableRow
      template={COLS}
      className={ok ? undefined : "bg-amber/[0.06] md:py-1"}
    >
      <span className="font-mono text-[12px] font-semibold text-fg2">
        {r.type}
      </span>
      <span className="flex min-w-0 items-center">
        <span
          className="min-w-0 truncate font-mono text-[12.5px]"
          title={r.name}
        >
          {r.name}
        </span>
        <CopyButton text={r.name} label={`Copy name of ${r.type} record`} />
      </span>
      <span className="flex min-w-0 items-center">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg2"
          title={r.value}
        >
          {r.value}
        </span>
        <CopyButton text={r.value} label={`Copy value of ${r.type} record`} />
      </span>
      <span className="font-mono text-[12.5px] text-fg2">
        {r.priority ?? ""}
      </span>
      <span className="font-mono text-[12.5px] text-fg2">{r.ttl}</span>
      <span className="flex flex-col">
        <span className="self-start">
          <Badge status={r.status} />
        </span>
        {!ok && (
          <span className="text-[12px] text-fg3">
            {r.status === "failed" ? "value does not match" : "not found yet"}
          </span>
        )}
      </span>
    </TableRow>
  );
}

function Tracking({
  domain,
  onDomain,
}: {
  domain: Domain;
  onDomain: (d: Domain) => void;
}) {
  const { session } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const host = session.tracking_hostname;

  const set = (patch: {
    open_tracking?: boolean;
    click_tracking?: boolean;
  }) => {
    setBusy(true);
    api<Domain>(`/domains/${encodeURIComponent(domain.id)}`, {
      method: "PATCH",
      body: patch,
    })
      .then(
        (d) => {
          onDomain(d);

          return undefined;
        },
        (cause: unknown) => {
          toast({ tone: "error", message: errorText(cause) });

          return undefined;
        },
      )
      .then(() => setBusy(false));
  };

  return (
    <section className="flex flex-col gap-3 border-b border-line px-4 py-4 md:border-r md:border-b-0 md:px-8 md:py-[18px]">
      <span className="font-semibold">Tracking</span>
      <Toggle
        checked={domain.open_tracking}
        disabled={busy}
        onChange={(v) => set({ open_tracking: v })}
      >
        <span className="flex flex-col">
          <span>Open tracking</span>
          <span className="text-[12.5px] text-fg3">
            adds a 1 px image to count opens
          </span>
        </span>
      </Toggle>
      <Toggle
        checked={domain.click_tracking}
        disabled={busy}
        onChange={(v) => set({ click_tracking: v })}
      >
        <span className="flex flex-col">
          <span>Click tracking</span>
          <span className="text-[12.5px] text-fg3">
            routes links through {host ?? "the Worker URL"}
          </span>
        </span>
      </Toggle>
      <span className="text-[13px] text-fg2">
        {host ? (
          <>
            Without a custom tracking domain, links would point at the Worker
            URL, which some spam filters distrust. Yours uses{" "}
            <span className="font-mono text-fg">{host}</span>.
          </>
        ) : (
          "Links point at the Worker URL, which some spam filters distrust. Set a custom tracking domain in Settings."
        )}
      </span>
    </section>
  );
}

function Events({
  domain,
  onDomain,
}: {
  domain: Domain;
  onDomain: (d: Domain) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const sub = domain.event_subscription;

  const repair = () => {
    setBusy(true);
    api<Domain>(`/domains/${encodeURIComponent(domain.id)}/subscription`, {
      method: "POST",
    })
      .then(
        (d) => {
          onDomain(d);

          if (d.event_subscription.status !== "active")
            toast({
              tone: "error",
              message: d.event_subscription.error ?? "The repair did not work.",
            });

          return undefined;
        },
        (cause: unknown) => {
          toast({ tone: "error", message: errorText(cause) });

          return undefined;
        },
      )
      .then(() => setBusy(false));
  };

  return (
    <section className="flex flex-col gap-2.5 border-b border-line px-4 py-4 md:border-r md:border-b-0 md:px-8 md:py-[18px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Delivery events</span>
        <Badge status={sub.status} />
      </div>
      <span className="text-[13.5px] text-fg2">
        {sub.status === "active"
          ? "fullsend gets delivery, bounce and complaint events from Cloudflare for this domain."
          : sub.status === "error"
            ? "The event subscription failed, so fullsend gets no events from Cloudflare for this domain."
            : "This domain has no event subscription, so fullsend gets no events from Cloudflare for it."}
      </span>
      {sub.error && (
        <span className="font-mono text-[12px] break-words text-red">
          {sub.error}
        </span>
      )}
      {sub.status !== "active" && domain.cf_zone_id && (
        <Button
          icon="reload"
          busy={busy}
          onClick={repair}
          className="self-start"
        >
          repair
        </Button>
      )}
    </section>
  );
}
