import { useEffect, useState } from "react";
import { type ApiKey, api, type Domain, type Settings } from "../api";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  Notice,
  PageHeader,
  RelTime,
  SecretReveal,
  Select,
  SkeletonBlock,
  TableHead,
  TableRow,
  cx,
  errorText,
} from "../components/ui";
import { useApi, useTitle } from "../lib/hooks";
import { useQuery } from "../lib/router";

const TEMPLATE = "minmax(0,1fr) 130px 150px 160px 110px 130px 110px 150px";

const COLUMNS = [
  "name",
  "prefix",
  "permission",
  "domain",
  "rate limit",
  "last used",
  "created",
  "",
];

type Created = ApiKey & { token: string };

const permissionLabel = (p: ApiKey["permission"]) =>
  p === "full_access" ? "Full access" : "Sending access";

// A label that shows only on a narrow screen, where the header row hides.
function Mobile({ children }: { children: string }) {
  return <span className="mr-1.5 text-fg3 md:hidden">{children}</span>;
}

export function ApiKeys() {
  useTitle("API keys");
  const keys = useApi<{ data: ApiKey[] }>("/api-keys");
  const domains = useApi<{ data: Domain[] }>("/domains");
  const [query] = useQuery();
  const focusId = query.get("key");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const list = keys.data?.data;

  const domainName = (id: string | null) =>
    id
      ? (domains.data?.data.find((d) => d.id === id)?.name ?? "unknown domain")
      : "all domains";

  // A link from the command palette scrolls to its row.
  useEffect(() => {
    if (!focusId || !list) return;
    document
      .getElementById(`key-${focusId}`)
      ?.scrollIntoView({ block: "center" });
  }, [focusId, list]);

  return (
    <>
      <PageHeader
        title="API keys"
        subtitle="Your apps send one of these with every request. Give each app its own key so you can revoke one without breaking the rest."
        actions={
          <Button
            variant="primary"
            icon="plus"
            className="max-md:h-11"
            onClick={() => setCreating(true)}
          >
            create api key
          </Button>
        }
      />
      <TableHead template={TEMPLATE} columns={COLUMNS} />
      {keys.error && !list ? (
        <ErrorState
          error={keys.error}
          title="Could not load API keys"
          onRetry={() => void keys.reload()}
        />
      ) : !list ? (
        <KeySkeleton show={keys.loading} />
      ) : list.length === 0 ? (
        <EmptyState
          icon="lock"
          title="No API keys yet"
          action={
            <Button
              variant="primary"
              icon="plus"
              onClick={() => setCreating(true)}
            >
              create api key
            </Button>
          }
        >
          Create a key so an app can send email through fullsend.
        </EmptyState>
      ) : (
        list.map((k) => (
          <div key={k.id} id={`key-${k.id}`} role="presentation">
            <TableRow
              template={TEMPLATE}
              className={cx(
                "min-h-14",
                k.id === focusId &&
                  "bg-hover shadow-[inset_3px_0_0_var(--accent)]",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon name="lock" className="text-fg3" />
                <span className="truncate font-mono text-[13px] font-semibold">
                  {k.name}
                </span>
              </span>
              <span className="font-mono text-[12.5px]">
                <Mobile>prefix</Mobile>
                {k.prefix}…
              </span>
              <span className="text-[13.5px]">
                {permissionLabel(k.permission)}
              </span>
              <span className="font-mono text-[12.5px] text-fg2">
                <Mobile>domain</Mobile>
                {domainName(k.domain_id)}
              </span>
              <span className="font-mono text-[12.5px] text-fg2">
                <Mobile>rate limit</Mobile>
                {k.rate_limit === null ? "default" : `${k.rate_limit} / s`}
              </span>
              <span className="text-fg2">
                <Mobile>last used</Mobile>
                {k.last_used_at ? (
                  <RelTime at={k.last_used_at} />
                ) : (
                  <span className="font-mono text-[12px]">never</span>
                )}
              </span>
              <span className="text-fg2">
                <Mobile>created</Mobile>
                <RelTime at={k.created_at} />
              </span>
              <span className="flex md:justify-end">
                <Button
                  size="sm"
                  icon="close"
                  className="text-red max-md:h-11"
                  onClick={() => setRevoking(k)}
                >
                  revoke
                </Button>
              </span>
            </TableRow>
          </div>
        ))
      )}
      <p className="m-0 px-4 py-3.5 text-[13px] text-fg2 md:px-8">
        Full access can manage domains, keys and webhooks. Sending access can
        only send, and only from the domain you pick. Use sending access for app
        servers.
      </p>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create API key"
        width={520}
      >
        <CreateForm
          domains={domains.data?.data ?? []}
          onCancel={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
            void keys.reload();
          }}
        />
      </Dialog>

      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Key created"
        width={520}
        locked
      >
        {created && (
          <div className="flex flex-col gap-3">
            <SecretReveal secret={created.token} />
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {[
                permissionLabel(created.permission),
                domainName(created.domain_id),
                created.rate_limit === null
                  ? "default rate limit"
                  : `${created.rate_limit} per second`,
              ].map((t) => (
                <li
                  key={t}
                  className="inline-flex h-6 items-center border border-line2 px-2 font-mono text-[12px] text-fg2"
                >
                  {t}
                </li>
              ))}
            </ul>
            <p className="m-0 text-[13px] text-fg2">
              fullsend stores only a hash, so a lost key must be replaced.
            </p>
            <DialogFooter>
              <Button icon="check" onClick={() => setCreated(null)}>
                I saved it
              </Button>
            </DialogFooter>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.name ?? ""}?`}
        body="Apps using this key get a 401 right away."
        action="revoke key"
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await api(`/api-keys/${revoking.id}`, { method: "DELETE" });
          await keys.reload();
        }}
      />
    </>
  );
}

// The skeleton copies the real row. It shows after the 150 ms delay.
function KeySkeleton({ show }: { show: boolean }) {
  if (!show) return <div className="h-14" />;

  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="grid min-h-14 grid-cols-1 items-center gap-2 border-b border-line px-4 py-3 md:gap-x-4 md:px-8 md:py-1 md:[grid-template-columns:var(--cols)]"
          style={{ "--cols": TEMPLATE }}
        >
          <SkeletonBlock className="h-2.5 w-3/5" />
          <SkeletonBlock className="h-2.5 w-16" />
          <SkeletonBlock className="h-2.5 w-24" />
          <SkeletonBlock className="h-2.5 w-24" />
          <SkeletonBlock className="h-2.5 w-12" />
          <SkeletonBlock className="h-2.5 w-16" />
          <SkeletonBlock className="h-2.5 w-14" />
          <span />
        </div>
      ))}
    </div>
  );
}

function CreateForm({
  domains,
  onCancel,
  onCreated,
}: {
  domains: Domain[];
  onCancel: () => void;
  onCreated: (key: Created) => void;
}) {
  const settings = useApi<Settings>("/settings");
  const [name, setName] = useState("");

  const [permission, setPermission] =
    useState<ApiKey["permission"]>("sending_access");

  const [domainId, setDomainId] = useState("");
  const [rate, setRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultRate = settings.data?.settings.default_rate_limit;

  const rateNumber = rate === "" ? null : Number(rate);

  const rateBad =
    rateNumber !== null &&
    (!Number.isInteger(rateNumber) || rateNumber < 1 || rateNumber > 1000);

  const nameBad = name.trim().length > 50;

  const submit = async () => {
    setBusy(true);
    setError(null);

    try {
      const key = await api<Created>("/api-keys", {
        method: "POST",
        body: {
          name: name.trim(),
          permission,
          domain_id:
            permission === "sending_access" && domainId ? domainId : null,
          rate_limit: rateNumber,
        },
      });

      onCreated(key);
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

        if (name.trim() && !rateBad && !nameBad) void submit();
      }}
    >
      <Field
        label="Name"
        error={nameBad ? "Use 50 characters or fewer." : undefined}
      >
        <Input
          autoFocus
          value={name}
          invalid={nameBad}
          placeholder="billing-service"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-[13px] text-fg2">Permission</legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {(
            [
              ["full_access", "Full access", "everything"],
              ["sending_access", "Sending access", "send only"],
            ] as const
          ).map(([value, title, note]) => {
            const on = permission === value;

            return (
              <label
                key={value}
                className={cx(
                  "flex min-h-11 cursor-pointer gap-2 border p-2.5",
                  on ? "border-accent-fg bg-panel" : "border-line2",
                )}
              >
                <input
                  type="radio"
                  name="permission"
                  className="peer sr-only"
                  checked={on}
                  onChange={() => setPermission(value)}
                />
                <Icon
                  name={on ? "checkbox" : "checkbox-on"}
                  className={cx(
                    on ? "text-accent-fg" : "text-fg3",
                    "peer-focus-visible:outline-2 peer-focus-visible:outline-accent-fg",
                  )}
                />
                <span className="flex flex-col">
                  <span className="font-medium text-fg">{title}</span>
                  <span className="text-[12.5px] text-fg3">{note}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <Field
        label="Domain"
        hint={
          permission === "full_access"
            ? "Full access covers all domains."
            : undefined
        }
      >
        <Select
          value={permission === "full_access" ? "" : domainId}
          disabled={permission === "full_access"}
          onChange={setDomainId}
          options={[
            { value: "", label: "all domains" },
            ...domains.map((d) => ({ value: d.id, label: d.name })),
          ]}
        />
      </Field>
      <Field
        label="Rate limit per second"
        error={rateBad ? "Use a whole number from 1 to 1000." : undefined}
        hint={
          defaultRate
            ? `Default for new keys is ${defaultRate}, set in Settings.`
            : "Leave empty to use the default from Settings."
        }
      >
        <Input
          inputMode="numeric"
          value={rate}
          invalid={rateBad}
          placeholder={defaultRate}
          onChange={(e) => setRate(e.target.value)}
        />
      </Field>
      {error && <Notice tone="red">{error}</Notice>}
      <DialogFooter>
        <Button onClick={onCancel}>cancel</Button>
        <Button
          type="submit"
          variant="primary"
          icon="lock"
          busy={busy}
          disabled={!name.trim() || rateBad || nameBad}
        >
          create key
        </Button>
      </DialogFooter>
    </form>
  );
}
