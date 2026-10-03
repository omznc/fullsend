import { useEffect, useRef, useState } from "react";
import {
  api,
  type CfSuppression,
  qs,
  type Suppression,
  type SuppressionList,
} from "../api";
import {
  Button,
  ButtonLink,
  Dialog,
  DialogFooter,
  EmptyState,
  ErrorState,
  errorText,
  Field,
  Icon,
  Input,
  Notice,
  PageHeader,
  Pager,
  RelTime,
  SectionTitle,
  Select,
  Skeleton,
  TableHead,
  TableRow,
  Textarea,
  TextLink,
  useToast,
} from "../components/ui";
import { relative, utc } from "../lib/format";
import { useApi, useNow, useTitle } from "../lib/hooks";
import { useQuery } from "../lib/router";

const LIMIT = 50;

const COLS = "minmax(0,1fr) 170px 200px 150px 130px";

const CF_COLS = "minmax(0,1fr) 170px 200px 150px";

// The reason values that the Worker writes. See the events consumer.
interface Reason {
  label: string;
  color: string;
  plain: string;
}

const REASONS = new Map<string, Reason>([
  [
    "hard_bounce",
    {
      label: "hard bounce",
      color: "text-red",
      plain: "the mail server refused it for good",
    },
  ],
  [
    "complaint",
    { label: "complaint", color: "text-amber", plain: "reported as spam" },
  ],
  ["manual", { label: "manual", color: "text-fg2", plain: "added by you" }],
]);

const reasonOf = (r: string): Reason =>
  REASONS.get(r) ?? {
    label: r.replace(/_/g, " "),
    color: "text-fg2",
    plain: "",
  };

interface CfList {
  available: boolean;
  error?: string;
  data: CfSuppression[];
}

export function Suppressions() {
  useTitle("Suppressions");
  const [query, setQuery] = useQuery();
  const q = query.get("q") ?? "";
  const after = query.get("after");
  const before = query.get("before");
  const reason = query.get("reason");
  const [text, setText] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const path = `/suppressions${qs({ q, reason, limit: LIMIT, after, before })}`;
  const list = useApi<SuppressionList>(path);
  const cf = useApi<CfList>("/suppressions/cloudflare");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Suppression | null>(null);

  const rows = list.data?.data ?? [];
  const counts = list.data?.counts ?? {};
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  // The known reasons in a fixed order, then any other reason. Only a
  // reason that has addresses shows.
  const chips = [
    { value: null, label: "all", n: total },
    ...[...new Set([...REASONS.keys(), ...Object.keys(counts)])].flatMap((k) =>
      k in counts
        ? [{ value: k, label: reasonOf(k).label, n: counts[k] ?? 0 }]
        : [],
    ),
  ];

  const filtered = q !== "" || reason !== null;

  const hasNext = before ? true : Boolean(list.data?.has_more);
  const hasPrev = before ? Boolean(list.data?.has_more) : Boolean(after);

  return (
    <>
      <PageHeader
        title="Suppressions"
        subtitle="Addresses fullsend will not email. This protects your reputation with mail providers."
        actions={
          <>
            <ButtonLink
              href={`/api/suppressions/export${qs({ q, reason })}`}
              icon="download"
            >
              export CSV
            </ButtonLink>
            <Button
              variant="primary"
              icon="plus"
              onClick={() => setAdding(true)}
            >
              add addresses
            </Button>
          </>
        }
      />
      <div className="px-4 pb-4 md:px-8">
        <Notice tone="blue" title="Cloudflare keeps its own list too.">
          An address removed here can still be blocked by Cloudflare Email
          Service if it bounced hard there. That list is managed in the
          Cloudflare dashboard.
        </Notice>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-4 py-3 md:px-8">
        <label className="relative w-full md:w-80">
          <span className="sr-only">Search address</span>
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-fg3"
          />
          <Input
            data-list-search
            type="search"
            value={text}
            placeholder="search address"
            autoCapitalize="none"
            spellCheck={false}
            className="h-11 pl-9 md:h-9"
            onChange={(e) => {
              const v = e.target.value;
              setText(v);
              clearTimeout(timer.current);
              timer.current = setTimeout(
                () => setQuery({ q: v.trim(), after: null, before: null }),
                300,
              );
            }}
          />
        </label>
        {total > 0 &&
          chips.map((c) => {
            const on = (reason ?? null) === c.value;

            return (
              <button
                key={c.label}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setQuery({ reason: c.value, after: null, before: null })
                }
                className={
                  "h-11 border px-2.5 font-mono text-[12px] md:h-9 " +
                  (on
                    ? "border-fg2 text-fg"
                    : "border-line2 text-fg3 hover:text-fg")
                }
              >
                {c.label}
                {` ${c.n}`}
              </button>
            );
          })}
      </div>

      {list.error && !list.data && (
        <ErrorState
          error={list.error}
          title="Could not load suppressions"
          onRetry={() => void list.reload()}
        />
      )}
      {list.loading && !list.data && (
        <>
          <TableHead
            template={COLS}
            columns={["address", "reason", "source email", "added", ""]}
          />
          <Skeleton rows={6} />
        </>
      )}
      {list.data && rows.length === 0 && (
        <EmptyState
          icon="shield"
          title={filtered ? "No address matches" : "No suppressed addresses"}
        >
          {filtered
            ? "Change the search or the reason filter."
            : "fullsend adds an address here after a hard bounce or a complaint. You can also add one by hand."}
        </EmptyState>
      )}
      {rows.length > 0 && (
        <div role="table" aria-label="Suppressed addresses">
          <TableHead
            template={COLS}
            columns={[
              <span key="a" className="flex items-center text-fg">
                address
                <Icon name="arrow-up" />
              </span>,
              "reason",
              "source email",
              "added",
              "",
            ]}
          />
          {rows.map((r) => {
            const why = reasonOf(r.reason);

            return (
              <TableRow key={r.address} template={COLS}>
                <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">
                  {r.address}
                </span>
                <span className="flex flex-col">
                  <span
                    className={`font-mono text-[12.5px] font-medium ${why.color}`}
                  >
                    {why.label}
                  </span>
                  {why.plain && (
                    <span className="text-[12px] text-fg3">{why.plain}</span>
                  )}
                </span>
                {r.email_id ? (
                  <TextLink
                    href={`/emails/${r.email_id}`}
                    iconEnd="external-link"
                    className="font-mono text-[12.5px] text-fg2"
                  >
                    {r.email_id.slice(0, 8)}
                  </TextLink>
                ) : (
                  <span className="font-mono text-[12.5px] text-fg3">
                    added by hand
                  </span>
                )}
                <RelTime at={r.created_at} className="text-fg2" />
                <span className="flex md:justify-end">
                  <Button
                    size="sm"
                    icon="trash"
                    className="h-11 md:h-8"
                    aria-label={`Remove ${r.address}`}
                    onClick={() => setRemoving(r)}
                  >
                    remove
                  </Button>
                </span>
              </TableRow>
            );
          })}
        </div>
      )}
      {list.data && (
        <Pager
          hasPrev={hasPrev}
          hasNext={hasNext}
          onPrev={() => setQuery({ before: rows[0]?.address, after: null })}
          onNext={() =>
            setQuery({ after: rows[rows.length - 1]?.address, before: null })
          }
        />
      )}

      <CloudflareList cf={cf.data} error={cf.error} />

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add addresses"
        width={520}
      >
        <AddBody
          onClose={() => setAdding(false)}
          onAdded={() => void list.reload()}
        />
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? `Email ${removing.address} again?` : ""}
      >
        {removing && (
          <RemoveBody
            row={removing}
            onClose={() => setRemoving(null)}
            onRemoved={() => void list.reload()}
          />
        )}
      </Dialog>
    </>
  );
}

// The most addresses that the Worker takes in one call.
const MAX_ADD = 100;

const ADD_REASONS = [
  { value: "manual", label: "manual: you block it" },
  { value: "hard_bounce", label: "hard bounce" },
  { value: "complaint", label: "complaint" },
];

// One address on each line. Empty lines and repeats do not count.
const parseLines = (text: string): string[] => [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  ),
];

function AddBody({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [reason, setReason] = useState("manual");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addresses = parseLines(text);
  const tooMany = addresses.length > MAX_ADD;

  const submit = async () => {
    setBusy(true);
    setError(null);

    try {
      const res = await api<{ added: number; skipped: number }>(
        "/suppressions/batch",
        { method: "POST", body: { emails: addresses, reason } },
      );

      toast({
        tone: "success",
        message:
          `${res.added} address${res.added === 1 ? "" : "es"} blocked.` +
          (res.skipped ? ` ${res.skipped} already on the list.` : ""),
      });
      onAdded();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();

        if (addresses.length > 0 && !tooMany) void submit();
      }}
    >
      <Field
        label="Email addresses"
        hint={`One address on each line. ${addresses.length} of ${MAX_ADD}. fullsend will not send email to them.`}
        error={
          error ??
          (tooMany ? `Add ${MAX_ADD} addresses or fewer at a time.` : null)
        }
      >
        <Textarea
          autoFocus
          rows={7}
          value={text}
          invalid={Boolean(error) || tooMany}
          placeholder={"name@example.com\nother@example.com"}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      <Field label="Reason">
        <Select
          aria-label="Reason"
          value={reason}
          options={ADD_REASONS}
          onChange={setReason}
        />
      </Field>
      <DialogFooter>
        <Button onClick={onClose}>cancel</Button>
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={addresses.length === 0 || tooMany}
        >
          {addresses.length > 1
            ? `add ${addresses.length} addresses`
            : "add address"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RemoveBody({
  row,
  onClose,
  onRemoved,
}: {
  row: Suppression;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = () => {
    setBusy(true);
    setError(null);
    api(`/suppressions/${encodeURIComponent(row.address)}`, {
      method: "DELETE",
    })
      .then(
        () => {
          toast({ tone: "success", message: `${row.address} is removed.` });
          onRemoved();
          onClose();

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
    <>
      <p className="m-0">
        {row.reason === "hard_bounce"
          ? `This address bounced hard ${relative(row.created_at, now)}. If it still does not exist, the next email bounces too and raises your bounce rate.`
          : row.reason === "complaint"
            ? "This person reported your email as spam. Email them again only if they ask for it."
            : "fullsend will send email to this address again."}
      </p>
      {error && (
        <Notice tone="red" className="mt-3">
          {error}
        </Notice>
      )}
      <DialogFooter>
        <Button onClick={onClose}>keep it blocked</Button>
        <Button
          variant="danger-solid"
          icon="trash"
          busy={busy}
          onClick={remove}
        >
          remove
        </Button>
      </DialogFooter>
    </>
  );
}

// The list that Cloudflare keeps for the account. It is read-only.
function CloudflareList({
  cf,
  error,
}: {
  cf: CfList | null;
  error: Error | null;
}) {
  if (error)
    return (
      <div className="px-4 py-4 md:px-8">
        <Notice tone="amber">
          Could not read the Cloudflare list: {errorText(error)}
        </Notice>
      </div>
    );

  if (!cf) return null;

  if (!cf.available) {
    // Without a token the Worker returns no error. Show nothing then.
    return cf.error ? (
      <div className="px-4 py-4 md:px-8">
        <Notice tone="amber">
          Could not read the Cloudflare list: {cf.error}
        </Notice>
      </div>
    ) : null;
  }

  return (
    <section className="mt-6 flex flex-col gap-3 border-t border-line pt-5">
      <SectionTitle
        className="px-4 md:px-8"
        title="On the Cloudflare list"
        subtitle="Read-only. Manage these addresses in the Cloudflare dashboard."
      />
      {cf.data.length === 0 ? (
        <p className="m-0 px-4 text-fg2 md:px-8">
          The Cloudflare list has no addresses.
        </p>
      ) : (
        <div role="table" aria-label="Cloudflare suppressions">
          <TableHead
            template={CF_COLS}
            columns={["address", "reason", "note", "added"]}
          />
          {cf.data.map((r) => (
            <TableRow key={r.id} template={CF_COLS}>
              <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">
                {r.email}
              </span>
              <span className="font-mono text-[12.5px] text-fg2">
                {r.reason.replace(/_/g, " ")}
              </span>
              <span className="text-[12.5px] text-fg3">
                {r.note ??
                  (r.scope?.type === "sending_domain"
                    ? r.scope.value
                    : "account")}
              </span>
              <span
                className="font-mono text-[12px] text-fg2"
                title={utc(r.created_at)}
              >
                {r.created_at.slice(0, 10)}
              </span>
            </TableRow>
          ))}
        </div>
      )}
    </section>
  );
}
