import { type ReactNode, useCallback, useState } from "react";
import { api, type Domain } from "../../api";
import {
  Badge,
  Button,
  CopyButton,
  errorText,
  Field,
  Icon,
  Input,
  Notice,
  SidePanel,
} from "../../components/ui";
import { useApi } from "../../lib/hooks";
import { navigate } from "../../lib/router";
import { recordIcon, useVerifyPoll, VerifyBanner } from "./verify";

interface Zone {
  id: string;
  name: string;
}

interface SendingDomain {
  tag: string;
  name: string;
  enabled: boolean;
}

type Step = "domain" | "dns" | "events";

const STEPS: { value: Step; label: string }[] = [
  { value: "domain", label: "domain" },
  { value: "dns", label: "dns records" },
  { value: "events", label: "delivery events" },
];

// The panel that adds a domain. Without a Cloudflare token it only
// imports a domain that the owner onboarded in the Cloudflare dashboard.
export function AddDomain({
  open,
  canManage,
  existing,
  onClose,
  onChanged,
}: {
  open: boolean;
  canManage: boolean;
  existing: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={canManage ? "Add domain" : "Import from Cloudflare"}
    >
      {canManage ? (
        <Onboard existing={existing} onClose={onClose} onChanged={onChanged} />
      ) : (
        <ImportOnly onClose={onClose} onChanged={onChanged} />
      )}
    </SidePanel>
  );
}

function ImportOnly({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setBusy(true);
    setError(null);
    api<Domain>("/domains/import", { method: "POST", body: { name } })
      .then(
        (d) => {
          onChanged();
          onClose();
          navigate(`/domains/${d.id}`);

          return undefined;
        },
        (cause: unknown) => {
          setError(errorText(cause));
          setBusy(false);

          return undefined;
        },
      )
      .then(() => undefined);
  };

  return (
    <form
      className="flex flex-col gap-4 px-4 py-5 md:px-6"
      onSubmit={(e) => {
        e.preventDefault();
        run();
      }}
    >
      <Notice tone="amber" icon="lock" title="Read-only: no Cloudflare token.">
        Onboard the domain to Email Sending in the Cloudflare dashboard first.
        Then enter its name here.
      </Notice>
      <Field
        label="Domain name"
        hint="fullsend trusts that the domain is ready to send."
        error={error}
      >
        <Input
          autoFocus
          value={name}
          invalid={Boolean(error)}
          placeholder="mail.yourcompany.com"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>cancel</Button>
        <Button
          type="submit"
          variant="primary"
          icon="cloud-download"
          busy={busy}
          disabled={!name.trim()}
        >
          import domain
        </Button>
      </div>
    </form>
  );
}

function Onboard({
  existing,
  onClose,
  onChanged,
}: {
  existing: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [step, setStep] = useState<Step>("domain");
  const [domain, setDomain] = useState<Domain | null>(null);
  const current = STEPS.findIndex((x) => x.value === step);

  return (
    <div className="flex min-h-full flex-col">
      <div
        role="list"
        className="grid grid-cols-3 border-b border-line font-mono text-[12px]"
      >
        {STEPS.map((s, i) => {
          const done = i < current;

          return (
            <span
              key={s.value}
              role="listitem"
              aria-current={s.value === step ? "step" : undefined}
              className={
                "flex h-10 items-center gap-0.5 px-3 md:px-4 " +
                (s.value === step
                  ? "text-fg shadow-[inset_0_-2px_0_var(--accent)]"
                  : done
                    ? "text-fg2"
                    : "text-fg3")
              }
            >
              {done && <Icon name="check" className="text-green" />}
              {!done && `${i + 1} `}
              {s.label}
            </span>
          );
        })}
      </div>
      {step === "domain" && (
        <NameStep
          existing={existing}
          onCancel={onClose}
          onCreated={(d) => {
            setDomain(d);
            setStep("dns");
            onChanged();
          }}
        />
      )}
      {step === "dns" && domain && (
        <DnsStep
          key={domain.id}
          domain={domain}
          onDomain={setDomain}
          onNext={() => setStep("events")}
        />
      )}
      {step === "events" && domain && (
        <EventsStep
          domain={domain}
          onDomain={(d) => {
            setDomain(d);
            onChanged();
          }}
          onBack={() => setStep("dns")}
          onDone={() => {
            onClose();
            navigate(`/domains/${domain.id}`);
          }}
        />
      )}
    </div>
  );
}

function NameStep({
  existing,
  onCancel,
  onCreated,
}: {
  existing: string[];
  onCancel: () => void;
  onCreated: (d: Domain) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useApi<{ data: Zone[] }>("/cloudflare/zones");
  const typed = name.trim().toLowerCase();

  const zone = zones.data?.data.find(
    (z) => typed === z.name || typed.endsWith(`.${z.name}`),
  );

  const sending = useApi<{ data: SendingDomain[] }>(
    zone ? `/cloudflare/zones/${zone.id}/sending-domains` : null,
  );

  const onboarded = (sending.data?.data ?? []).filter(
    (d) => !existing.includes(d.name),
  );

  const isOnboarded = onboarded.some((d) => d.name === typed);

  const submit = () => {
    setBusy(true);
    setError(null);
    api<Domain>("/domains", { method: "POST", body: { name } })
      .then(
        (d) => {
          onCreated(d);

          return undefined;
        },
        (cause: unknown) => {
          setError(errorText(cause));
          setBusy(false);

          return undefined;
        },
      )
      .then(() => undefined);
  };

  return (
    <form
      className="flex flex-1 flex-col gap-4 px-4 py-5 md:px-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field
        label="Domain name"
        hint="We suggest a subdomain like mail.yourcompany.com."
        error={error}
      >
        <Input
          autoFocus
          value={name}
          invalid={Boolean(error)}
          placeholder="mail.yourcompany.com"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      {isOnboarded && (
        <Notice tone="blue">
          Cloudflare already has {typed} in Email Sending. fullsend will use it.
        </Notice>
      )}
      {(zones.data?.data.length ?? 0) > 0 && (
        <Suggestions
          title="Your Cloudflare zones"
          items={(zones.data?.data ?? []).map((z) => ({
            key: z.id,
            label: z.name,
            value: `mail.${z.name}`,
          }))}
          onPick={setName}
        />
      )}
      {onboarded.length > 0 && (
        <Suggestions
          title="Already in Email Sending"
          items={onboarded.map((d) => ({
            key: d.tag,
            label: d.name,
            value: d.name,
          }))}
          onPick={setName}
        />
      )}
      <div className="mt-auto flex justify-end gap-2 border-t border-line pt-5">
        <Button onClick={onCancel}>cancel</Button>
        <Button
          type="submit"
          variant="primary"
          iconEnd="chevron-right"
          busy={busy}
          disabled={!name.trim()}
        >
          add domain
        </Button>
      </div>
    </form>
  );
}

function Suggestions({
  title,
  items,
  onPick,
}: {
  title: string;
  items: { key: string; label: string; value: string }[];
  onPick: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-fg2">{title}</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <button
            key={i.key}
            type="button"
            onClick={() => onPick(i.value)}
            className="h-9 border border-line2 bg-transparent px-2.5 font-mono text-[12px] text-fg2 hover:text-fg"
          >
            {i.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function DnsStep({
  domain,
  onDomain,
  onNext,
}: {
  domain: Domain;
  onDomain: (d: Domain) => void;
  onNext: () => void;
}) {
  const poll = useVerifyPoll(domain.id, onDomain, true);
  const missing = domain.records.filter((r) => r.status !== "verified");

  return (
    <>
      <div className="flex flex-1 flex-col gap-3.5 px-4 py-5 md:px-6">
        <span className="font-mono text-[13px] font-semibold">
          {domain.name}
        </span>
        <VerifyBanner records={domain.records} poll={poll} />
        <div>
          {domain.records.map((r, i) => {
            const icon = recordIcon(r.status);

            return (
              <div
                key={`${r.type}${r.name}${i}`}
                className="flex min-h-11 items-center gap-2.5 border-b border-line"
              >
                <span className="w-[50px] shrink-0 font-mono text-[12px] font-semibold text-fg2">
                  {r.type}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                  {r.name}
                </span>
                <CopyButton text={r.value} label={`Copy value of ${r.name}`} />
                <span className={icon.color}>
                  <Icon name={icon.name} />
                  <span className="sr-only">{r.status}</span>
                </span>
              </div>
            );
          })}
        </div>
        {domain.records.length === 0 && (
          <span className="text-fg2">Cloudflare has not sent records yet.</span>
        )}
        {missing.length > 0 && poll.attempts > 0 && (
          <div className="flex flex-col gap-1.5 bg-panel px-3.5 py-3 text-[13.5px] text-fg2">
            <span className="text-[14px] font-semibold text-fg">
              Add by hand
            </span>
            {missing.map((r, i) => (
              <span key={i} className="[overflow-wrap:anywhere]">
                {r.type} <code className="font-mono text-fg">{r.name}</code>{" "}
                with value <code className="font-mono text-fg">{r.value}</code>
              </span>
            ))}
          </div>
        )}
      </div>
      <PanelFooter>
        <span />
        <Button variant="primary" iconEnd="chevron-right" onClick={onNext}>
          continue
        </Button>
      </PanelFooter>
    </>
  );
}

function EventsStep({
  domain,
  onDomain,
  onBack,
  onDone,
}: {
  domain: Domain;
  onDomain: (d: Domain) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sub = domain.event_subscription;

  const repair = useCallback(() => {
    setBusy(true);
    setError(null);
    api<Domain>(`/domains/${encodeURIComponent(domain.id)}/subscription`, {
      method: "POST",
    })
      .then(
        (d) => {
          onDomain(d);

          return undefined;
        },
        (cause: unknown) => {
          setError(errorText(cause));

          return undefined;
        },
      )
      .then(() => setBusy(false));
  }, [domain.id, onDomain]);

  return (
    <>
      <div className="flex flex-1 flex-col gap-3.5 px-4 py-5 md:px-6">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold text-fg">Delivery events</span>
          <Badge status={sub.status} />
        </div>
        <span className="text-[13.5px] text-fg2">
          {sub.status === "active"
            ? "fullsend gets delivery, bounce and complaint events from Cloudflare for this domain."
            : "fullsend gets no delivery events from Cloudflare for this domain until the subscription works."}
        </span>
        {sub.error && <Notice tone="red">{sub.error}</Notice>}
        {error && <Notice tone="red">{error}</Notice>}
        {sub.status !== "active" && (
          <Button
            icon="reload"
            busy={busy}
            onClick={repair}
            className="self-start"
          >
            repair
          </Button>
        )}
      </div>
      <PanelFooter>
        <Button icon="chevron-left" onClick={onBack}>
          back
        </Button>
        <Button variant="primary" iconEnd="chevron-right" onClick={onDone}>
          done
        </Button>
      </PanelFooter>
    </>
  );
}

function PanelFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-between border-t border-line px-4 py-5 md:px-6">
      {children}
    </div>
  );
}
