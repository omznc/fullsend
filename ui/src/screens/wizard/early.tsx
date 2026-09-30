import { useState } from "react";
import { api, type CloudflareStatus, type Domain, type Probe } from "../../api";
import {
  CF_PERMISSIONS,
  cloudflareCheck,
  type Fix,
  fixedIn,
  HowToFix,
  permName,
  TokenSteps,
} from "../../components/fix";
import {
  Badge,
  CopyButton,
  ErrorState,
  Field,
  Icon,
  Input,
  Notice,
  Select,
  SkeletonBlock,
  errorText,
} from "../../components/ui";
import { useApi, useInterval, useNow } from "../../lib/hooks";
import { Hint, type Flow, Mono, NeedDomain, Rows, StepFrame } from "./parts";

// Steps 1 to 4: the token, the domain, the DNS records, the events.

// Step 1: the Cloudflare connection

export function StepCloudflare({ flow }: { flow: Flow }) {
  const cf = useApi<CloudflareStatus>("/cloudflare");
  const [busy, setBusy] = useState(false);
  // A pasted token reaches the Worker some seconds after the save.
  const [saved, setSaved] = useState(false);

  useInterval(
    () => {
      if (!busy) void cf.reload();
    },
    saved && !cf.data?.token_set ? 3000 : null,
  );

  const recheck = async () => {
    setBusy(true);

    try {
      await cf.reload();
    } finally {
      setBusy(false);
    }
  };

  const d = cf.data;
  const perms = d?.permissions;

  const missing = perms
    ? CF_PERMISSIONS.filter((p) => !perms[p.key].ok).length
    : 0;

  // The "how to fix" check. It also updates this step.
  const checkFor = (fix: Fix) =>
    cloudflareCheck(cf.setData, (next) => fixedIn(fix, next));

  // Zone Read and Email Sending are the two that a domain needs.
  const ready = Boolean(perms?.zone_read.ok && perms.email_sending.ok);

  return (
    <StepFrame
      narrow={flow.narrow}
      footer={{
        back: () => flow.go(0),
        skip: {
          label: "skip, I will add domains by hand",
          onClick: () => flow.go(2),
        },
        second: {
          label: "check again",
          icon: "reload",
          onClick: recheck,
          busy,
        },
        primary: { disabled: !ready, onClick: () => flow.go(2) },
      }}
    >
      {cf.error ? (
        <ErrorState
          error={cf.error}
          title="Could not check Cloudflare"
          onRetry={() => void cf.reload()}
          className="!px-0 !py-4"
        />
      ) : !d ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <SkeletonBlock className="h-12" />
          <SkeletonBlock className="h-10" />
          <SkeletonBlock className="h-10" />
          <SkeletonBlock className="h-10" />
        </div>
      ) : !d.token_set ? (
        <>
          <Notice tone="amber" title="No Cloudflare token">
            fullsend cannot reach Cloudflare without a token. You can still add
            domains by hand.
          </Notice>
          <TokenSteps onSaved={() => setSaved(true)} />
        </>
      ) : !d.valid ? (
        <>
          <Notice tone="red" title="Cloudflare refused the token">
            {d.error ?? "The token is not valid."}
            <HowToFix
              fix={{ kind: "token_invalid" }}
              check={checkFor({ kind: "token_invalid" })}
              className="mt-1.5"
            />
          </Notice>
          <Hint>
            Open "How to fix?" and paste a new token. fullsend replaces the old
            one.
          </Hint>
        </>
      ) : (
        <>
          <Rows>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
              <span className="flex flex-col">
                <span className="font-medium">
                  API token for {d.account?.name ?? "your account"}
                </span>
                <span className="font-mono text-[12px] text-fg3">
                  CF_API_TOKEN · account{" "}
                  {d.account ? shortId(d.account.id) : ""}
                </span>
              </span>
              {missing ? (
                <Badge
                  status="pending"
                  tone="amber"
                  label="missing permissions"
                  hollow={false}
                />
              ) : (
                <Badge status="active" label="valid" />
              )}
            </div>
            {CF_PERMISSIONS.map((p) => {
              const probe: Probe | undefined = perms?.[p.key];
              const ok = probe?.ok;
              const fix: Fix = { kind: "permissions", missing: [p.key] };

              return (
                <div
                  key={p.key}
                  className="flex min-h-10 items-center gap-2 border-b border-line py-1.5"
                >
                  <Icon
                    name={ok ? "check" : "close"}
                    className={ok ? "text-green" : "text-red"}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-mono text-[12.5px]">
                      {permName(p)}
                    </span>
                    {!ok && probe?.error && (
                      <span className="text-[12px] text-fg3 [overflow-wrap:anywhere]">
                        {probe.error}
                      </span>
                    )}
                    {!ok && (
                      <HowToFix
                        fix={fix}
                        check={checkFor(fix)}
                        className="mt-0.5"
                      />
                    )}
                  </span>
                  <span
                    className={`font-mono text-[12px] ${ok ? "text-green" : "text-red"}`}
                  >
                    {ok ? "granted" : "missing"}
                  </span>
                </div>
              );
            })}
          </Rows>
          <Hint>
            {missing
              ? "Edit the token in Cloudflare, add the missing permissions, then check again. No redeploy needed."
              : "The token has every permission. Continue to pick the sending domain."}
          </Hint>
        </>
      )}
    </StepFrame>
  );
}

const shortId = (id: string) =>
  id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;

// Step 2: the sending domain

export function StepDomain({ flow }: { flow: Flow }) {
  const zones = useApi<{ data: { id: string; name: string }[] }>(
    flow.tokenSet ? "/cloudflare/zones" : null,
  );

  const [zonePick, setZonePick] = useState<string | null>(null);

  const zone =
    zones.data?.data.find((z) => z.id === zonePick) ??
    zones.data?.data[0] ??
    null;

  const existing = useApi<{
    data: { tag: string; name: string; enabled: boolean }[];
  }>(zone ? `/cloudflare/zones/${zone.id}/sending-domains` : null);

  const [label, setLabel] = useState("mail");
  const [manual, setManual] = useState(flow.domain?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byToken = flow.tokenSet && zone;

  const name = byToken
    ? label
      ? `${label.trim().toLowerCase()}.${zone.name}`
      : zone.name
    : manual.trim().toLowerCase();

  const suggestions = zone
    ? [
        ...new Set([
          `mail.${zone.name}`,
          `email.${zone.name}`,
          zone.name,
          ...(existing.data?.data.map((e) => e.name) ?? []),
        ]),
      ]
    : [];

  const pick = (full: string) => {
    if (!zone) return;
    setLabel(full === zone.name ? "" : full.slice(0, -zone.name.length - 1));
  };

  const submit = async () => {
    if (flow.domain && flow.domain.name === name) {
      flow.go(3);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      const path = flow.tokenSet ? "/domains" : "/domains/import";
      const made = await api<Domain>(path, { method: "POST", body: { name } });
      flow.setDomain(made);

      if (made.status !== "verified") flow.poll.start(made.id);
      flow.go(3);
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
        back: () => flow.go(1),
        primary: {
          disabled: !name || (Boolean(flow.tokenSet) && !zone),
          busy,
          onClick: submit,
        },
      }}
    >
      {flow.tokenSet && zones.error ? (
        <ErrorState
          error={zones.error}
          title="Could not list your zones"
          onRetry={() => void zones.reload()}
          className="!px-0 !py-4"
        />
      ) : flow.tokenSet && !zones.data ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <SkeletonBlock className="h-14" />
          <SkeletonBlock className="h-14" />
        </div>
      ) : flow.tokenSet && !zone ? (
        <Notice tone="amber" title="No zone found">
          This token sees no active zone. Add your domain to Cloudflare first,
          then go back and check again.
        </Notice>
      ) : (
        <>
          {byToken ? (
            <>
              <Field label="Zone">
                <Select
                  value={zone.id}
                  onChange={setZonePick}
                  className="h-10"
                  options={(zones.data?.data ?? []).map((z) => ({
                    value: z.id,
                    label: z.name,
                  }))}
                />
              </Field>
              <Field label="Send from" error={error}>
                <span className="flex h-10 items-center border border-line2 bg-panel px-2.5 font-mono text-[13px] focus-within:border-accent-fg focus-within:shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_30%,transparent)]">
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    aria-label="Subdomain"
                    spellCheck={false}
                    autoCapitalize="none"
                    className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] text-fg outline-none"
                  />
                  <span className="text-fg3">
                    {label ? `.${zone.name}` : zone.name}
                  </span>
                </span>
              </Field>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] text-fg3">Try</span>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => pick(s)}
                    className={`h-8 border px-2.5 font-mono text-[12.5px] text-fg ${
                      s === name
                        ? "border-accent-fg bg-raised"
                        : "border-line2 bg-transparent"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <Notice
                tone="blue"
                title="Without a token, fullsend cannot check the domain"
              >
                Onboard the domain in the Cloudflare dashboard under Email
                Service. Then type its name here.
              </Notice>
              <Field label="Domain name" error={error}>
                <Input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="mail.example.com"
                  spellCheck={false}
                  autoCapitalize="none"
                  className="h-10"
                />
              </Field>
            </>
          )}
          <Hint title="Why a subdomain">
            Use a subdomain to keep your main domain's reputation separate. If
            an app misbehaves, your main domain itself stays trusted.
          </Hint>
        </>
      )}
    </StepFrame>
  );
}

// Step 3: the DNS records

export function StepDns({ flow }: { flow: Flow }) {
  const { domain, poll } = flow;
  const now = useNow(1000);

  if (!domain)
    return (
      <StepFrame narrow={flow.narrow} footer={{ back: () => flow.go(2) }}>
        <NeedDomain go={flow.go} />
      </StepFrame>
    );

  const records = domain.records;
  const found = records.filter((r) => r.status === "verified").length;
  const verified = domain.status === "verified";

  const seconds = poll.nextAt
    ? Math.max(0, Math.ceil((poll.nextAt - now) / 1000))
    : 0;

  const missing = records.filter((r) => r.status !== "verified");

  return (
    <StepFrame
      narrow={flow.narrow}
      footer={{
        back: () => flow.go(2),
        skip: { label: "skip, verify later", onClick: () => flow.go(4) },
        second: {
          label: "verify now",
          icon: "reload",
          busy: poll.busy,
          onClick: () => poll.start(domain.id),
        },
        primary: { disabled: !verified, onClick: () => flow.go(4) },
      }}
    >
      <div
        role="status"
        className="flex flex-wrap items-center gap-2 border border-line2 px-3 py-2.5"
      >
        {verified ? (
          <>
            <Icon name="check" className="text-green" />
            <span className="font-medium">Verified</span>
            <span className="text-fg2">
              {records.length
                ? `All ${records.length} records found.`
                : "fullsend has no records to check for this domain."}
            </span>
          </>
        ) : poll.phase === "failed" ? (
          <>
            <Icon name="alert" className="text-red" />
            <span className="font-medium">Verification failed</span>
            <span className="text-fg2">
              After 30 minutes, {missing.length} of {records.length} records are
              still missing.
            </span>
          </>
        ) : poll.phase === "running" ? (
          <>
            <Icon name="loader" className="animate-spin text-accent-fg" />
            <span className="font-medium">Checking DNS</span>
            <span className="text-fg2">
              {found} of {records.length} found.
              {poll.busy ? " Checking now." : ` Next check in ${seconds} s.`}
            </span>
            <span className="ml-auto font-mono text-[12px] text-fg3">
              attempt {poll.attempt}
            </span>
          </>
        ) : (
          <>
            <Icon name="info-box" className="text-fg3" />
            <span className="font-medium">Not checked yet</span>
            <span className="text-fg2">
              {found} of {records.length} found. Press verify now.
            </span>
          </>
        )}
      </div>
      {poll.phase === "failed" && !verified && missing.length > 0 && (
        <Notice tone="red" title="Still missing">
          {missing.map((r) => `${r.type} ${r.name}`).join(", ")}
        </Notice>
      )}
      <Rows>
        {records.map((r) => {
          const ok = r.status === "verified";

          return (
            <div
              key={`${r.type}-${r.name}-${r.value}`}
              className={`grid items-center gap-x-3.5 gap-y-1 border-b border-line py-2.5 ${
                flow.narrow
                  ? "grid-cols-1"
                  : "grid-cols-[60px_200px_minmax(0,1fr)_170px]"
              }`}
            >
              <span className="font-mono text-[12px] font-semibold text-fg2">
                {r.type}
              </span>
              <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">
                {r.name}
              </span>
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg2">
                  {r.priority !== undefined ? `${r.priority} ` : ""}
                  {r.value}
                </span>
                <CopyButton text={r.value} label="Copy value" bordered />
              </span>
              <span className="flex flex-col">
                <span className="self-start">
                  <Badge
                    status={
                      ok
                        ? "verified"
                        : r.status === "failed"
                          ? "failed"
                          : "pending"
                    }
                    label={ok ? "verified" : r.status}
                  />
                </span>
                <span className="text-[12px] text-fg3">
                  {ok
                    ? "found"
                    : r.status === "failed"
                      ? "wrong value"
                      : "not found yet"}
                </span>
              </span>
            </div>
          );
        })}
      </Rows>
      {!records.length && !verified && (
        <Hint>
          The Worker has no record list yet. Press verify now and Cloudflare
          adds the records.
        </Hint>
      )}
      {!verified && (
        <Hint>
          Verify now checks DNS every 10 s for 5 minutes, then every 60 s. You
          can leave this page. A toast says when the domain is ready.
        </Hint>
      )}
    </StepFrame>
  );
}

// Step 4: the delivery events

const SUB_LABEL = {
  active: "made",
  missing: "not made",
  error: "error",
} as const;

export function StepEvents({ flow }: { flow: Flow }) {
  const { domain } = flow;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!domain)
    return (
      <StepFrame narrow={flow.narrow} footer={{ back: () => flow.go(3) }}>
        <NeedDomain go={flow.go} />
      </StepFrame>
    );

  const sub = domain.event_subscription;

  const repair = async () => {
    setBusy(true);
    setError(null);

    try {
      flow.setDomain(
        await api<Domain>(`/domains/${domain.id}/subscription`, {
          method: "POST",
        }),
      );
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
        back: () => flow.go(3),
        skip: { label: "skip this step", onClick: () => flow.go(5) },
        second: { label: "check again", icon: "reload", busy, onClick: repair },
        primary: { onClick: () => flow.go(5) },
      }}
    >
      <div className="flex flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-col">
            <span className="font-medium">Event subscription</span>
            <span className="font-mono text-[12px] text-fg3">
              {domain.name} to the events queue
            </span>
          </span>
          <Badge
            status={sub.status}
            label={SUB_LABEL[sub.status]}
            hollow={sub.status === "missing"}
          />
        </div>
        <div className="py-2.5 text-fg2">
          {sub.status === "active"
            ? "Subscribed to delivered, delivery_delayed, bounced and complained."
            : sub.status === "error"
              ? "Cloudflare could not make the subscription."
              : "The subscription is not made yet. Check again to make it."}
        </div>
      </div>
      {(sub.error || error) && (
        <Notice tone="red" title="Reason">
          <span className="[overflow-wrap:anywhere]">{error ?? sub.error}</span>
        </Notice>
      )}
      {sub.status !== "active" && (
        <Hint title="If the token cannot make it">
          <span className="block">
            1. Cloudflare, Email Service, Event subscriptions.
          </span>
          <span className="block">
            2. Add the destination: the Cloudflare Queue{" "}
            <Mono>fullsend-events</Mono>.
          </span>
          <span className="block">
            3. Tick all delivery events, save, then check again.
          </span>
        </Hint>
      )}
    </StepFrame>
  );
}
