import { type ReactNode, useState } from "react";
import { api, type CloudflareStatus, type PermKey } from "../api";
import { useInterval } from "../lib/hooks";
import {
  Button,
  CopyValue,
  Dialog,
  Notice,
  TextLink,
  errorText,
  useToast,
} from "./ui";

// "How to fix?" for the Cloudflare token problems. A link opens a dialog
// with the steps. While the dialog is open, it checks again every few
// seconds. When the check passes, the dialog closes and a toast says so.

// The token permissions that fullsend uses, in the order of the Cloudflare
// token form.
export const CF_PERMISSIONS: {
  key: PermKey;
  group: "Account" | "Zone";
  resource: string;
  access: "Read" | "Edit";
  // The permission key of the dashboard token template.
  template: string;
  // A short name for a compact list.
  label: string;
  use: string;
}[] = [
  {
    key: "zone_read",
    template: "zone",
    group: "Zone",
    resource: "Zone",
    access: "Read",
    label: "Zone read",
    use: "to list your zones",
  },
  {
    key: "email_sending",
    template: "email_sending",
    group: "Account",
    resource: "Email Sending",
    access: "Edit",
    label: "Email Sending",
    use: "to add sending domains",
  },
  {
    key: "queues",
    template: "queues",
    group: "Account",
    resource: "Queues",
    access: "Edit",
    label: "Queues",
    use: "to receive delivery events",
  },
  {
    key: "access",
    template: "access",
    group: "Account",
    resource: "Access: Apps and Policies",
    access: "Edit",
    label: "Access apps",
    use: "to protect the dashboard",
  },
  {
    key: "access_org",
    template: "access_acct",
    group: "Account",
    resource: "Access: Organizations, Identity Providers, and Groups",
    access: "Read",
    label: "Access org",
    use: "to read the team domain",
  },
  {
    key: "workers_scripts",
    template: "workers_scripts",
    group: "Account",
    resource: "Workers Scripts",
    access: "Edit",
    label: "Workers scripts",
    use: "to attach hostnames",
  },
];

export const permName = (p: (typeof CF_PERMISSIONS)[number]) =>
  `${p.group} · ${p.resource} · ${p.access}`;

export type Fix =
  | { kind: "token_missing" }
  | { kind: "token_invalid" }
  | { kind: "permissions"; missing: PermKey[] };

// The check for a fix. It returns true when the problem is gone.
export type FixCheck = () => Promise<boolean>;

// A check that loads /cloudflare again. `apply` gives the new status to the
// screen, so the screen updates too.
export function cloudflareCheck(
  apply: (d: CloudflareStatus) => void,
  fixed: (d: CloudflareStatus) => boolean,
): FixCheck {
  return async () => {
    const next = await api<CloudflareStatus>("/cloudflare");
    apply(next);

    return fixed(next);
  };
}

// The status passes the fix when the token works and has each permission.
export const fixedIn = (fix: Fix, d: CloudflareStatus): boolean =>
  fix.kind === "permissions"
    ? Boolean(d.permissions && fix.missing.every((k) => d.permissions![k].ok))
    : d.token_set && d.valid;

const TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

// An account token form with every permission of fullsend filled in. The
// dashboard asks for the account first. README.md and the deploy form in
// package.json have the same URL.
export const TOKEN_TEMPLATE_URL = `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodeURIComponent(
  JSON.stringify(
    CF_PERMISSIONS.map((p) => ({
      key: p.template,
      type: p.access.toLowerCase(),
    })),
  ),
)}&name=fullsend`;

const WORKERS_URL =
  "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

const ZERO_TRUST_URL = "https://one.dash.cloudflare.com/";

const ACCOUNT_ID_URL =
  "https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/";

const EVERY_MS = 5000;

const TITLE: Record<Fix["kind"], string> = {
  token_missing: "Connect a Cloudflare token",
  token_invalid: "Replace the Cloudflare token",
  permissions: "Add the missing permissions",
};

const FIXED: Record<Fix["kind"], string> = {
  token_missing: "The Cloudflare token works.",
  token_invalid: "The Cloudflare token works.",
  permissions: "The token has the permissions now.",
};

export function HowToFix({
  fix,
  check,
  label = "How to fix?",
  className,
}: {
  fix: Fix;
  check: FixCheck;
  label?: string;
  className?: string;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);

    try {
      const ok = await check();
      setCheckedAt(Date.now());
      setError(null);

      if (ok) {
        setOpen(false);
        toast({ tone: "success", message: FIXED[fix.kind] });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  useInterval(
    () => {
      if (!busy) void run();
    },
    open ? EVERY_MS : null,
  );

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setCheckedAt(null);
          setError(null);
          setOpen(true);
        }}
        className={`flex w-fit items-center border-0 bg-transparent p-0 font-mono text-[12.5px] text-fg underline underline-offset-3 hover:text-accent-fg ${className ?? ""}`}
      >
        {label}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={TITLE[fix.kind]}
        width={560}
        footer={
          <>
            <span
              aria-live="polite"
              className="mr-auto self-center font-mono text-[12px] text-fg3"
            >
              {busy
                ? "checking"
                : checkedAt
                  ? `not fixed yet · checked ${new Date(checkedAt).toLocaleTimeString()}`
                  : `checks again every ${EVERY_MS / 1000} seconds`}
            </span>
            <Button onClick={() => setOpen(false)}>close</Button>
            <Button
              variant="primary"
              icon="reload"
              busy={busy}
              onClick={() => void run()}
            >
              check again
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <FixSteps fix={fix} />
          <span>
            You do not need to deploy again. This dialog closes when the check
            passes.
          </span>
          {error && (
            <Notice tone="red" title="The check failed">
              {error}
            </Notice>
          )}
        </div>
      </Dialog>
    </>
  );
}

function FixSteps({ fix }: { fix: Fix }) {
  if (fix.kind === "permissions") {
    const rows = CF_PERMISSIONS.filter((p) => fix.missing.includes(p.key));

    return (
      <>
        <Ol>
          <li>
            Open <TextLink href={TOKENS_URL}>API Tokens</TextLink> in the
            Cloudflare dashboard.
          </li>
          <li>
            Find the token that fullsend uses. Open its menu and select{" "}
            <b>Edit</b>.
          </li>
          <li>
            Under <b>Permissions</b>, add{" "}
            {rows.length > 1 ? "these rows" : "this row"}:
            <PermTable rows={rows} />
          </li>
          <li>
            Make sure that <b>Account Resources</b> includes this account
            {fix.missing.includes("zone_read") &&
              " and that Zone Resources includes the zones that you send from"}
            .
          </li>
          <li>
            Select <b>Continue to summary</b>, then <b>Update token</b>. The
            token value does not change, so the Worker secrets stay the same.
          </li>
        </Ol>
        <span>
          You can also{" "}
          <TextLink href={TOKEN_TEMPLATE_URL}>
            make a new token from the template
          </TextLink>{" "}
          and put its value in the <Code>CF_API_TOKEN</Code> secret.
        </span>
        {(fix.missing.includes("access") ||
          fix.missing.includes("access_org")) && (
          <Notice tone="blue" title="No Zero Trust on the account?">
            The check also fails when the account has no Zero Trust
            organization. Open{" "}
            <TextLink href={ZERO_TRUST_URL}>Zero Trust</TextLink> one time and
            choose a team name. The Free plan is sufficient.
          </Notice>
        )}
      </>
    );
  }

  return (
    <Ol>
      {fix.kind === "token_invalid" ? (
        <li>
          Cloudflare refused the token. It is possible that someone deleted or
          rolled the token, that it expired, or that <Code>CF_ACCOUNT_ID</Code>{" "}
          is for a different account. Open{" "}
          <TextLink href={TOKENS_URL}>API Tokens</TextLink> and find the token.
          If it is gone, make a new one as in the next steps.
        </li>
      ) : null}
      <li>
        Open the <TextLink href={TOKEN_TEMPLATE_URL}>token template</TextLink>.
        It fills in the permissions of fullsend. If Cloudflare asks for an
        account, choose the account of this Worker.
      </li>
      <li>
        Make sure that the form has these rows. Add a row that is not there:
        <PermTable rows={CF_PERMISSIONS} />
        Set the zone resources to the zones that you send from.
      </li>
      <li>
        Select <b>Continue to summary</b>, then <b>Create Token</b>. Copy the
        token value.
      </li>
      <li>
        Copy the account ID. It is on the account home page (
        <TextLink href={ACCOUNT_ID_URL}>where to find it</TextLink>).
      </li>
      <li>
        Open <TextLink href={WORKERS_URL}>Workers &amp; Pages</TextLink>, then
        the fullsend Worker. Go to <b>Settings</b>, then{" "}
        <b>Variables and Secrets</b>. Add two values of the type <b>Secret</b>:
        <span className="mt-1.5 flex flex-col gap-1">
          <CopyValue value="CF_API_TOKEN" />
          <CopyValue value="CF_ACCOUNT_ID" />
        </span>
      </li>
    </Ol>
  );
}

function Ol({ children }: { children: ReactNode }) {
  return (
    <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 marker:font-mono marker:text-fg3">
      {children}
    </ol>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="font-mono text-fg">{children}</code>
);

function PermTable({ rows }: { rows: typeof CF_PERMISSIONS }) {
  return (
    <span className="my-1.5 flex flex-col border-t border-line">
      {rows.map((p) => (
        <span
          key={p.key}
          className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-line py-1.5"
        >
          <span className="font-mono text-[12.5px] text-fg">{permName(p)}</span>
          <span className="text-[12px] text-fg3">{p.use}</span>
        </span>
      ))}
    </span>
  );
}
