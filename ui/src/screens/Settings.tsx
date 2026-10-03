import { useState, type ReactNode } from "react";
import {
  api,
  type CloudflareStatus,
  type Hostnames,
  type Settings as SettingsData,
} from "../api";
import {
  CF_PERMISSIONS,
  cloudflareCheck,
  type Fix,
  fixedIn,
  HowToFix,
} from "../components/fix";
import {
  Badge,
  Button,
  ButtonLink,
  ConfirmDialog,
  ErrorState,
  Field,
  Icon,
  Input,
  Notice,
  PageHeader,
  Segmented,
  SkeletonBlock,
  Toggle,
  errorText,
  useToast,
} from "../components/ui";
import { useApi, useTitle } from "../lib/hooks";
import { useTheme, type ThemeChoice } from "../lib/theme";

type Reload = () => Promise<void>;

function Section({
  icon,
  title,
  help,
  children,
}: {
  icon: string;
  title: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <section className="grid border-b border-line md:grid-cols-[320px_minmax(0,1fr)]">
      <div className="flex flex-col gap-1.5 px-4 pt-5 md:border-r md:border-line md:px-8 md:py-5">
        <h2 className="m-0 flex items-center gap-2 text-[14px] font-semibold">
          <Icon name={icon} className="text-fg2" />
          {title}
        </h2>
        <span className="text-[13px] text-fg2">{help}</span>
      </div>
      <div>{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-[52px] items-center gap-x-4 gap-y-1.5 border-b border-line px-4 py-2.5 last:border-b-0 md:grid-cols-[240px_minmax(0,1fr)] md:px-8">
      <span className="flex flex-col">
        <span>{label}</span>
        {hint && <span className="text-[12.5px] text-fg3">{hint}</span>}
      </span>
      <span className="flex flex-wrap items-center gap-2 font-mono text-[12.5px]">
        {children}
      </span>
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  return (
    <>
      {items.map((c) => (
        <span key={c} className="bg-raised px-2 leading-[26px]">
          {c}
        </span>
      ))}
    </>
  );
}

// One setting with an input and a save button. The parent gives the
// saved value, so the draft is clean again after a save.
function ValueRow({
  label,
  hint,
  name,
  value,
  unit,
  numeric,
  onSaved,
}: {
  label: string;
  hint?: string;
  name: string;
  value: string;
  unit?: string;
  numeric?: boolean;
  onSaved: Reload;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = draft ?? value;
  const dirty = draft !== null && draft !== value;

  const save = async () => {
    setBusy(true);
    setError(null);

    try {
      await api("/settings", { method: "PATCH", body: { [name]: shown } });
      await onSaved();
      setDraft(null);
      toast({ tone: "success", message: `${label} saved.` });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row label={label} hint={hint}>
      <Field label={<span className="sr-only">{label}</span>} error={error}>
        <span className="flex items-center gap-2">
          <Input
            inputMode={numeric ? "numeric" : undefined}
            value={shown}
            invalid={Boolean(error)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && dirty) void save();
            }}
            className={numeric ? "w-[120px]" : "w-[220px]"}
          />
          {unit && <span className="text-fg2">{unit}</span>}
          <Button
            variant="primary"
            busy={busy}
            disabled={!dirty}
            onClick={() => void save()}
            className="max-md:h-11"
          >
            save
          </Button>
        </span>
      </Field>
    </Row>
  );
}

function ToggleRow({
  label,
  hint,
  name,
  value,
  onSaved,
}: {
  label: string;
  hint?: string;
  name: string;
  value: boolean;
  onSaved: Reload;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const flip = async () => {
    setBusy(true);

    try {
      await api("/settings", {
        method: "PATCH",
        body: { [name]: String(!value) },
      });
      await onSaved();
    } catch (err) {
      toast({ tone: "error", message: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row label={label} hint={hint}>
      <Toggle checked={value} onChange={() => void flip()} disabled={busy}>
        {value ? "on" : "off"}
      </Toggle>
    </Row>
  );
}

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "system" },
  { value: "dark", label: "dark" },
  { value: "light", label: "light" },
];

function Appearance() {
  const [theme, setTheme] = useTheme();

  return (
    <Section
      icon="sun"
      title="Appearance"
      help="The theme is kept in this browser only."
    >
      <Row label="Theme">
        <Segmented
          label="Theme"
          value={theme}
          options={THEMES}
          onChange={setTheme}
        />
      </Row>
    </Section>
  );
}

function CloudflareSection() {
  const cf = useApi<CloudflareStatus>("/cloudflare");
  const d = cf.data;
  const perms = d?.permissions;

  const missing = perms
    ? CF_PERMISSIONS.filter((p) => !perms[p.key].ok).map((p) => p.key)
    : [];

  // The "how to fix" check. It also updates this section.
  const checkFor = (fix: Fix) =>
    cloudflareCheck(cf.setData, (next) => fixedIn(fix, next));

  return (
    <Section
      icon="cloud"
      title="Cloudflare token"
      help="Used to set up domains, DNS, events and hostnames."
    >
      {cf.error && !d ? (
        <Notice
          className="mx-4 my-2 md:mx-8"
          tone="red"
          action={
            <Button onClick={() => void cf.reload()} icon="reload">
              retry
            </Button>
          }
        >
          {errorText(cf.error)}
        </Notice>
      ) : !d ? (
        <div
          aria-busy="true"
          aria-label="Loading"
          className="px-4 py-4 md:px-8"
        >
          <SkeletonBlock className="h-2.5 w-[60%]" />
        </div>
      ) : (
        <>
          <Row label="Status">
            {d.token_set ? (
              <>
                {d.account && <span>{d.account.name}</span>}
                <Badge
                  status={d.valid ? "active" : "error"}
                  label={d.valid ? "valid" : "invalid"}
                />
                {d.error && <span className="text-red">{d.error}</span>}
                {!d.valid && (
                  <HowToFix
                    fix={{ kind: "token_invalid" }}
                    check={checkFor({ kind: "token_invalid" })}
                  />
                )}
              </>
            ) : (
              <>
                <Badge status="unset" label="not set" />
                <span className="text-fg2">
                  Set CF_API_TOKEN and CF_ACCOUNT_ID as Worker secrets.
                </span>
                <HowToFix
                  fix={{ kind: "token_missing" }}
                  check={checkFor({ kind: "token_missing" })}
                />
              </>
            )}
          </Row>
          {perms && (
            <Row label="Permissions">
              {CF_PERMISSIONS.map(({ key: k, label }) => {
                const p = perms[k];

                return (
                  <span
                    key={k}
                    title={p.error}
                    className="inline-flex items-center gap-1 bg-raised px-2 leading-[26px]"
                  >
                    <Icon
                      name={p.ok ? "check" : "close"}
                      size={16}
                      className={p.ok ? "text-green" : "text-red"}
                    />
                    {label}
                  </span>
                );
              })}
              {missing.length > 0 && (
                <HowToFix
                  fix={{ kind: "permissions", missing }}
                  check={checkFor({ kind: "permissions", missing })}
                />
              )}
            </Row>
          )}
          <Row label="Setup wizard">
            <ButtonLink href="/setup/1" icon="reload" className="max-md:h-11">
              run setup again
            </ButtonLink>
          </Row>
        </>
      )}
    </Section>
  );
}

function PasswordRow() {
  const toast = useToast();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);

    try {
      await api("/settings/password", {
        method: "POST",
        body: { password: pw },
      });
      setPw("");
      toast({ tone: "success", message: "Password changed." });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      label="Password"
      hint="12 characters or more. The change signs out every other session."
    >
      <Field
        label={<span className="sr-only">New password</span>}
        error={error}
      >
        <span className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="new-password"
            value={pw}
            placeholder="new password"
            invalid={Boolean(error)}
            onChange={(e) => setPw(e.target.value)}
            className="w-[220px]"
          />
          <Button
            variant="primary"
            busy={busy}
            disabled={pw.length < 12}
            onClick={() => void save()}
            className="max-md:h-11"
          >
            change
          </Button>
        </span>
      </Field>
    </Row>
  );
}

function AccessSection({ data }: { data: SettingsData }) {
  const password = data.auth_mode === "password";

  return (
    <Section
      icon="shield"
      title={password ? "Sign in" : "Cloudflare Access"}
      help={
        password
          ? "One admin password protects this dashboard."
          : "Access decides who can open this dashboard. There is no password to change."
      }
    >
      {password ? (
        <PasswordRow />
      ) : (
        <>
          <Row label="Team domain">
            {data.access.team_domain ? (
              <span>{data.access.team_domain}</span>
            ) : (
              <span className="text-fg3">not set</span>
            )}
            <Badge
              status={data.access.configured ? "active" : "unset"}
              label={data.access.configured ? "configured" : "not configured"}
            />
          </Row>
          <Row label="Protected paths" hint="need an Access login">
            <span className="text-fg2">
              every other path, the dashboard included
            </span>
          </Row>
          <Row label="Public paths" hint="your apps call these with API keys">
            <Chips items={data.access.public_paths.map((p) => `${p}*`)} />
          </Row>
          <Row label="Manage">
            <ButtonLink
              href="https://one.dash.cloudflare.com/"
              icon="external-link"
              className="max-md:h-11"
            >
              open zero trust
            </ButtonLink>
          </Row>
        </>
      )}
    </Section>
  );
}

function HostnameBadge({ status }: { status: string }) {
  return <Badge status={status} />;
}

function Content({ data, reload }: { data: SettingsData; reload: Reload }) {
  const s = data.settings;
  const hosts = useApi<Hostnames>("/hostnames");
  const [purge, setPurge] = useState(false);
  const toast = useToast();

  return (
    <>
      <Appearance />
      <Section
        icon="archive"
        title="Retention"
        help="Old data is deleted every night. Shorter keeps your database small."
      >
        <ValueRow
          label="Email bodies"
          hint="HTML, text and attachments"
          name="body_retention_days"
          value={s.body_retention_days}
          unit="days"
          numeric
          onSaved={reload}
        />
        <ValueRow
          label="Email rows and events"
          hint="metadata and timelines"
          name="row_retention_days"
          value={s.row_retention_days}
          unit="days"
          numeric
          onSaved={reload}
        />
      </Section>
      <Section
        icon="link"
        title="Hostnames"
        help="Open pixels and click links use the tracking hostname. New domains have tracking on."
      >
        <Row label="API hostname">
          <span>{data.api_hostname ?? "not set"}</span>
          {hosts.data && (
            <HostnameBadge status={hosts.data.api_hostname.status} />
          )}
        </Row>
        <Row label="Tracking hostname">
          <span>{data.tracking_hostname ?? "not set"}</span>
          {hosts.data && (
            <HostnameBadge status={hosts.data.tracking_hostname.status} />
          )}
        </Row>
        {hosts.data?.error && (
          <Row label="Cloudflare">
            <span className="text-red">{hosts.data.error}</span>
          </Row>
        )}
        <ToggleRow
          label="Open tracking"
          hint="the default for new domains"
          name="default_open_tracking"
          value={s.default_open_tracking === "true"}
          onSaved={reload}
        />
        <ToggleRow
          label="Click tracking"
          hint="the default for new domains"
          name="default_click_tracking"
          value={s.default_click_tracking === "true"}
          onSaved={reload}
        />
      </Section>
      <Section
        icon="speed-fast"
        title="Rate limit"
        help="The starting limit for new API keys. You can change it per key."
      >
        <ValueRow
          label="Default per key"
          hint="1 to 1000, in steps of 10 per second"
          name="default_rate_limit"
          value={s.default_rate_limit}
          unit="per second"
          numeric
          onSaved={reload}
        />
      </Section>
      <Section
        icon="server"
        title="Deploy"
        help="The name of this deploy, shown in the dashboard."
      >
        <ValueRow
          label="Name"
          name="deploy_name"
          value={s.deploy_name}
          onSaved={reload}
        />
        <Row label="Version">
          <span className="text-fg3">{data.version}</span>
        </Row>
      </Section>
      <CloudflareSection />
      <AccessSection data={data} />
      <section className="grid md:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5 px-4 pt-5 md:border-r md:border-line md:px-8 md:py-5">
          <h2 className="m-0 text-[15px] font-semibold text-red">
            Danger zone
          </h2>
          <span className="text-[13px] text-fg2">Cannot be undone.</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-5 md:px-8">
          <span className="flex flex-col">
            <span className="font-semibold">Delete all emails and events</span>
            <span className="text-[13px] text-fg2">
              Keeps domains, keys and webhooks. Suppressions are deleted. You
              confirm by typing “delete all data”.
            </span>
          </span>
          <Button
            variant="danger"
            icon="trash"
            onClick={() => setPurge(true)}
            className="h-11 md:h-10"
          >
            delete all
          </Button>
        </div>
      </section>
      <ConfirmDialog
        open={purge}
        title="Delete all emails and events"
        body="This deletes every email, event, delivery and suppression, and the stored bodies. It cannot be undone."
        action="delete all"
        confirmText="delete all data"
        onClose={() => setPurge(false)}
        onConfirm={async () => {
          await api("/settings/purge", {
            method: "POST",
            body: { confirm: "delete all data" },
          });
          toast({ tone: "success", message: "All emails and events deleted." });
        }}
      />
    </>
  );
}

function SettingsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="grid border-b border-line md:grid-cols-[320px_minmax(0,1fr)]"
        >
          <div className="flex flex-col gap-2 px-4 py-5 md:px-8">
            <SkeletonBlock className="h-3 w-[120px]" />
            <SkeletonBlock className="h-2.5 w-[200px]" />
          </div>
          <div className="flex flex-col gap-4 px-4 py-5 md:px-8">
            <SkeletonBlock className="h-9 w-[60%]" />
            <SkeletonBlock className="h-9 w-[40%]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Settings() {
  useTitle("Settings");
  const res = useApi<SettingsData>("/settings");

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        title="Settings"
        subtitle="How long fullsend keeps data, who can sign in, and how it talks to Cloudflare."
      />
      <div className="border-t border-line" />
      {res.error && !res.data ? (
        <ErrorState
          error={res.error}
          title="Could not load the settings"
          onRetry={() => void res.reload()}
        />
      ) : !res.data ? (
        <SettingsSkeleton />
      ) : (
        <Content data={res.data} reload={res.reload} />
      )}
    </div>
  );
}
