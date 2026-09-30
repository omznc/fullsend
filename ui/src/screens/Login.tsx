import { type FormEvent, type ReactNode, useState } from "react";
import { type AccessInfo, api, ApiRequestError, type Session } from "../api";
import { type Fix, HowToFix, TokenSteps, WORKERS_URL } from "../components/fix";
import {
  Button,
  ButtonLink,
  Field,
  Icon,
  Input,
  Logo,
  Notice,
  SkeletonBlock,
  TextLink,
  errorText,
} from "../components/ui";
import { useApi, useInterval, useNow, useTitle } from "../lib/hooks";
import {
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  type JsonValue,
} from "../lib/json";

// The sign-in and setup screen. The Worker decides the state:
// locked, Access setup, or login (Access or password).

interface Hero {
  icon: string;
  color: string;
  title: string;
  sub: string;
}

const HERO = {
  locked: {
    icon: "lock",
    color: "var(--fg)",
    title: "This dashboard is locked.",
    sub: "Nobody can open it until the owner unlocks it and turns on Cloudflare Access.",
  },
  auto: {
    icon: "shield",
    color: "var(--accent-fg)",
    title: "Almost there. Access will guard the door.",
    sub: "Your API keeps working the whole time. Only the dashboard gets a login.",
  },
  manual: {
    icon: "shield",
    color: "var(--accent-fg)",
    title: "Access by hand.",
    sub: "Use this if your Cloudflare token cannot create Access apps.",
  },
  access: {
    icon: "shield",
    color: "var(--green)",
    title: "Access guards this dashboard.",
    sub: "No password here. Cloudflare Access handles sign-in.",
  },
  pw: {
    icon: "lock",
    color: "var(--amber)",
    title: "Password sign-in.",
    sub: "A simple fallback for deploys without Access.",
  },
  limit: {
    icon: "clock",
    color: "var(--red)",
    title: "Too many tries.",
    sub: "Sign-in is paused for a minute to slow down guessing.",
  },
} satisfies Record<string, Hero>;

export function Login({
  session,
  reload,
}: {
  session: Session;
  reload: () => Promise<void>;
}) {
  useTitle("Sign in");

  if (session.state === "locked")
    return <Locked session={session} reload={reload} />;

  if (session.state === "access_setup")
    return <AccessSetup session={session} reload={reload} />;

  if (session.mode === "password") return <Password session={session} />;

  return <ThroughAccess session={session} reload={reload} />;
}

function Layout({
  hero,
  session,
  children,
}: {
  hero: Hero;
  session: Session;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-dvh grid-cols-1 bg-bg text-fg md:grid-cols-2">
      <div className="flex flex-col justify-between border-b border-line px-5 py-4 md:border-r md:border-b-0 md:px-10 md:py-8">
        <Logo size={18} />
        <div className="hidden max-w-[460px] flex-col gap-3.5 md:flex">
          <span style={{ color: hero.color }}>
            <Icon name={hero.icon} size={48} />
          </span>
          <p className="m-0 text-[30px] leading-10 font-medium tracking-[-0.02em]">
            {hero.title}
          </p>
          <p className="m-0 text-fg2">{hero.sub}</p>
        </div>
        <span className="hidden font-mono text-[12px] text-fg3 md:block">
          {session.worker_url}
        </span>
      </div>
      <main className="flex items-center px-5 py-8 md:p-10">
        <div className="flex w-full max-w-[440px] flex-col gap-4.5">
          {children}
        </div>
      </main>
    </div>
  );
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="m-0 text-2xl leading-[30px] font-semibold">{title}</h1>
      {children && <span className="text-fg2">{children}</span>}
    </div>
  );
}

const wide = "h-11 w-full justify-center text-[13px] md:h-10";

function SmallLink({
  onClick,
  children,
}: {
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 items-center self-start border-0 bg-transparent p-0 font-mono text-[12.5px] text-fg2 underline underline-offset-3 hover:text-fg md:min-h-0"
    >
      {children}
    </button>
  );
}

// The first unlock. A Cloudflare token proves the ownership and connects
// the token in one step. The setup code in the Worker logs is the fallback.
function Locked({
  session,
  reload,
}: {
  session: Session;
  reload: () => Promise<void>;
}) {
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState(false);

  // After the save, wait for the Worker version that has the secrets.
  useInterval(
    () => {
      api<{ token_set: boolean }>("/setup/token")
        .then((r) => (r.token_set ? reload() : undefined))
        .catch(() => undefined);
    },
    saved ? 2000 : null,
  );

  if (code)
    return (
      <CodeForm session={session} reload={reload} back={() => setCode(false)} />
    );

  return (
    <Layout hero={HERO.locked} session={session}>
      <Heading title="Unlock this deploy">
        Connect a Cloudflare token of the account that runs this Worker. The
        token proves that you own this deploy. fullsend also uses it to set up
        domains and Access.
      </Heading>
      <TokenSteps onSaved={() => setSaved(true)} />
      <SmallLink onClick={() => setCode(true)}>
        {session.setup_token_set
          ? "Use the setup token instead"
          : "Use a setup code instead"}
      </SmallLink>
    </Layout>
  );
}

// The fallback: the setup code from the Worker logs, or SETUP_TOKEN.
function CodeForm({
  session,
  reload,
  back,
}: {
  session: Session;
  reload: () => Promise<void>;
  back: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = session.setup_token_set;

  function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api("/setup/unlock", { method: "POST", body: { token } })
      .then(() => reload())
      .catch((cause: unknown) => {
        setError(errorText(cause));
        setBusy(false);
      });
  }

  return (
    <Layout hero={HERO.locked} session={session}>
      <Heading title="Unlock with a code">
        {own ? (
          "Enter the SETUP_TOKEN secret of this Worker."
        ) : (
          <>
            The Worker writes a setup code to its logs. Open{" "}
            <TextLink href={WORKERS_URL}>Workers &amp; Pages</TextLink>, then
            this Worker, then <b>Logs</b>. Find the line{" "}
            <code className="font-mono text-fg">fullsend setup code</code>. If
            the line is not there, reload this page.
          </>
        )}
      </Heading>
      <form onSubmit={submit} className="flex flex-col gap-4.5">
        <Field label={own ? "Setup token" : "Setup code"} error={error}>
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            invalid={Boolean(error)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            className="h-11 font-mono md:h-10"
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          icon="lock-open"
          busy={busy}
          disabled={!token.trim()}
          className={wide}
        >
          unlock
        </Button>
      </form>
      <SmallLink onClick={back}>Use a Cloudflare token instead</SmallLink>
    </Layout>
  );
}

interface SetupStep {
  step: string;
  ok: boolean;
  detail?: string;
}

interface SetupResult {
  ok: boolean;
  steps: SetupStep[];
  login_url: string;
}

// The steps in the error body of an automatic setup. The Worker sends
// the steps that ran before the failure. A bad entry stays out.
function stepsOf(body: JsonValue): SetupStep[] {
  if (!isJsonObject(body) || !Array.isArray(body.steps)) return [];

  return body.steps.flatMap((s) => {
    if (!isJsonObject(s) || !isString(s.step) || !isBoolean(s.ok)) return [];
    const step: SetupStep = { step: s.step, ok: s.ok };

    if (isString(s.detail)) step.detail = s.detail;

    return [step];
  });
}

// The body of a manual Access setup. The hostname is only for a custom
// hostname, not for workers.dev.
interface ManualAccessBody {
  team_domain: string;
  aud: string;
  hostname?: string;
}

// The "how to fix" steps for the fix code of /setup/access.
const accessFix = (data: AccessInfo): Fix | null =>
  data.fix === "permissions"
    ? { kind: "permissions", missing: data.missing }
    : data.fix && { kind: data.fix };

function AccessSetup({
  session,
  reload,
}: {
  session: Session;
  reload: () => Promise<void>;
}) {
  const {
    data,
    error,
    reload: retry,
    setData,
  } = useApi<AccessInfo>("/setup/access");

  // Loads the Access state again. The form changes to the automatic setup
  // when the token can make the apps.
  const recheck = async () => {
    const next = await api<AccessInfo>("/setup/access");
    setData(next);

    return next.automatic;
  };

  // null: follow what the Worker says. true: the owner chose the manual steps.
  const [forceManual, setForceManual] = useState<boolean | null>(null);
  const [done, setDone] = useState<SetupResult | null>(null);
  // The owner chose a password in place of Access.
  const [password, setPassword] = useState(false);

  if (password)
    return (
      <Layout hero={HERO.pw} session={session}>
        <PasswordSetup />
        <SmallLink onClick={() => setPassword(false)}>
          use Cloudflare Access instead
        </SmallLink>
      </Layout>
    );

  if (error)
    return (
      <Layout hero={HERO.auto} session={session}>
        <Heading title="Protect it with Cloudflare Access" />
        <Notice
          tone="red"
          title="Could not read the setup state"
          action={
            <Button size="sm" onClick={retry}>
              retry
            </Button>
          }
        >
          {errorText(error)}
        </Notice>
      </Layout>
    );

  if (!data)
    return (
      <Layout hero={HERO.auto} session={session}>
        <SkeletonBlock className="h-[30px] w-3/4" />
        <SkeletonBlock className="h-10 w-full" />
        <SkeletonBlock className="h-10 w-full" />
      </Layout>
    );

  const manual = forceManual ?? !data.automatic;

  if (done)
    return (
      <Layout hero={HERO.auto} session={session}>
        <Heading title="Access is on">
          The dashboard now needs a sign-in through Cloudflare Access.
        </Heading>
        <Steps steps={done.steps} />
        <Notice tone="blue" title="Wait a few minutes">
          A new Access app can take some minutes to start. Until then, Access
          can refuse your email with "That account does not have access". Wait,
          then sign in again.
        </Notice>
        <ButtonLink
          href={done.login_url}
          variant="primary"
          icon="login"
          className={wide}
        >
          sign in at{" "}
          {done.login_url.replace(/^https:\/\//, "").replace(/\/$/, "")}
        </ButtonLink>
      </Layout>
    );

  return (
    <Layout hero={manual ? HERO.manual : HERO.auto} session={session}>
      {manual ? (
        <ManualForm
          data={data}
          session={session}
          reload={reload}
          recheck={recheck}
          onDone={(url) => setDone({ ok: true, steps: [], login_url: url })}
        />
      ) : (
        <AutoForm data={data} onDone={setDone} />
      )}
      {!manual && (
        <SmallLink onClick={() => setForceManual(true)}>
          set it up by hand instead
        </SmallLink>
      )}
      {manual && data.automatic && (
        <SmallLink onClick={() => setForceManual(false)}>
          set it up automatically instead
        </SmallLink>
      )}
      <SmallLink onClick={() => setPassword(true)}>
        use a password instead
      </SmallLink>
    </Layout>
  );
}

const STEP_LABEL = new Map([
  ["hostname", "Attached the hostname"],
  ["dashboard_app", "Created the Access app “fullsend dashboard”"],
  ["api_app", "Created the Access app “fullsend API”"],
  ["policy", "Added the policy for the owner emails"],
]);

function Steps({ steps, working }: { steps: SetupStep[]; working?: boolean }) {
  if (!steps.length && !working) return null;

  return (
    <ul
      className="m-0 list-none p-0"
      aria-live="polite"
      aria-label="Setup progress"
    >
      {steps.map((s, i) => (
        <li
          key={`${s.step}${i}`}
          className="flex min-h-10 items-center gap-2.5 border-b border-line py-1"
        >
          <span style={{ color: s.ok ? "var(--green)" : "var(--red)" }}>
            <Icon name={s.ok ? "check" : "alert"} />
          </span>
          <span className="min-w-0 flex-1">
            {s.ok ? (STEP_LABEL.get(s.step) ?? s.step) : (s.detail ?? s.step)}
          </span>
          {s.ok && s.detail && (
            <span className="max-w-40 truncate font-mono text-[12px] text-fg3">
              {s.detail}
            </span>
          )}
        </li>
      ))}
      {working && (
        <li className="flex min-h-10 items-center gap-2.5 border-b border-line py-1">
          <span className="text-accent-fg">
            <Icon name="loader" className="animate-spin" />
          </span>
          <span className="flex-1">Setting up Access</span>
          <span className="font-mono text-[12px] text-fg3">working</span>
        </li>
      )}
    </ul>
  );
}

function AutoForm({
  data,
  onDone,
}: {
  data: AccessInfo;
  onDone: (r: SetupResult) => void;
}) {
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  const [hostname, setHostname] = useState(
    data.hostname_is_workers_dev ? "" : data.hostname,
  );

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [steps, setSteps] = useState<SetupResult["steps"]>([]);

  const commit = () => {
    const parts = draft
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.includes("@"));

    if (parts.length) setEmails((prev) => [...new Set([...prev, ...parts])]);
    setDraft("");

    return parts;
  };

  const all = [
    ...emails,
    ...draft
      .split(/[\s,;]+/)
      .filter((s) => s.includes("@") && !emails.includes(s)),
  ];

  function submit(e: FormEvent) {
    e.preventDefault();
    commit();
    setBusy(true);
    setMessage(null);
    setSteps([]);
    api<SetupResult>("/setup/access/auto", {
      method: "POST",
      body: { emails: all, hostname: hostname.trim() },
    })
      .then((res) => {
        onDone(res);

        return res;
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiRequestError) setSteps(stepsOf(cause.body));

        setMessage(errorText(cause));
        setBusy(false);
      });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4.5">
      <Heading title="Protect it with Cloudflare Access">
        fullsend creates an Access app for the dashboard. Only these emails can
        sign in.
      </Heading>
      <Field label="Owner emails" hint="Press Enter or comma after each email">
        <span className="flex min-h-11 flex-wrap items-center gap-1.5 border border-line2 bg-panel px-2 py-1 font-mono text-[12.5px] focus-within:border-accent-fg md:min-h-10">
          {emails.map((m) => (
            <span key={m} className="flex items-center bg-raised pl-2 text-fg">
              {m}
              <button
                type="button"
                aria-label={`Remove ${m}`}
                onClick={() => setEmails(emails.filter((x) => x !== m))}
                className="grid size-8 place-items-center border-0 bg-transparent text-fg3 hover:text-fg md:size-6"
              >
                <Icon name="close" size={16} />
              </button>
            </span>
          ))}
          <input
            type="email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit();
              }
            }}
            onBlur={commit}
            autoComplete="email"
            className="h-8 min-w-40 flex-1 border-0 bg-transparent font-mono text-[12.5px] text-fg outline-none placeholder:text-fg3"
            placeholder={emails.length ? "" : "you@example.com"}
          />
        </span>
      </Field>
      <Field
        label="Dashboard hostname"
        hint={
          data.hostname_is_workers_dev
            ? "A custom hostname on a zone in your account. A workers.dev hostname cannot use Access."
            : "The hostname of the dashboard and the API"
        }
      >
        <Input
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="email.example.com"
          autoComplete="off"
          spellCheck={false}
          className="h-11 md:h-10"
        />
      </Field>
      <Steps steps={steps} working={busy} />
      {message && (
        <Notice tone="red" icon="alert">
          {message}
        </Notice>
      )}
      <Button
        type="submit"
        variant="primary"
        icon="shield"
        busy={busy}
        disabled={!all.length || !hostname.trim()}
        className={wide}
      >
        set up Access
      </Button>
    </form>
  );
}

function ManualForm({
  data,
  session,
  reload,
  recheck,
  onDone,
}: {
  data: AccessInfo;
  session: Session;
  reload: () => Promise<void>;
  recheck: () => Promise<boolean>;
  onDone: (loginUrl: string) => void;
}) {
  const [team, setTeam] = useState(data.team_domain ?? "");
  const [aud, setAud] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const host = data.hostname_is_workers_dev ? "" : data.hostname;
  const audOff = touched && aud.trim() !== "" && aud.trim().length !== 64;
  const fix = accessFix(data);

  function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const body: ManualAccessBody = { team_domain: team, aud };

    if (host) body.hostname = host;
    api("/setup/access/manual", { method: "POST", body })
      .then(() => {
        const target = host || session.api_hostname;

        if (target) onDone(`https://${target}/`);
        else void reload();

        return null;
      })
      .catch((cause: unknown) => {
        setMessage(errorText(cause));
        setBusy(false);
      });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4.5">
      <Heading title="Connect your Access app">
        Create the Access apps for {host || "your dashboard hostname"} in Zero
        Trust, then paste two values.
      </Heading>
      <Field label="Team domain" hint="For example acme.cloudflareaccess.com">
        <Input
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="h-11 md:h-10"
        />
      </Field>
      <Field
        label="Application audience (AUD) tag"
        error={
          audOff
            ? "AUD tags are 64 characters. Copy it from the app's Overview tab."
            : undefined
        }
      >
        <Input
          value={aud}
          onChange={(e) => setAud(e.target.value)}
          onBlur={() => setTouched(true)}
          invalid={audOff}
          autoComplete="off"
          spellCheck={false}
          className="h-11 md:h-10"
        />
      </Field>
      <div className="flex flex-col gap-1.5 bg-panel px-3.5 py-3 text-[13.5px] text-fg2">
        <span className="mb-1 block text-[14px] font-semibold text-fg">
          In Zero Trust
        </span>
        <span>1. Access, Applications, Add, Self-hosted.</span>
        <span>
          2. Domain{" "}
          <code className="font-mono text-fg">{host || "your hostname"}</code>,
          no path. Policy: allow your email. Save, then copy the AUD tag.
        </span>
        <span>
          3. Add a second app with a bypass policy for everyone on these paths:
        </span>
        <span className="flex flex-wrap gap-x-3 font-mono text-fg">
          {data.public_paths.map((p) => (
            <code key={p}>{p}</code>
          ))}
        </span>
      </div>
      {message && <Notice tone="red">{message}</Notice>}
      {data.reason && (
        <Notice tone="blue" title="Why not automatic">
          {data.reason}
          {fix && <HowToFix fix={fix} check={recheck} className="mt-1.5" />}
        </Notice>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          icon="check"
          busy={busy}
          disabled={!team.trim() || !aud.trim()}
          className="h-11 flex-1 justify-center text-[13px] md:h-10"
        >
          check and save
        </Button>
        <ButtonLink
          href="https://one.dash.cloudflare.com/"
          icon="external-link"
          className="h-11 md:h-10"
        >
          zero trust
        </ButtonLink>
      </div>
    </form>
  );
}

const MIN_PASSWORD = 12;

// The password login, in place of Access. After this step, the setup code
// and a pasted token open nothing.
function PasswordSetup() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = password.length > 0 && password.length < MIN_PASSWORD;
  const differ = confirm.length > 0 && confirm !== password;

  function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api("/setup/password", { method: "POST", body: { password } })
      .then(() => {
        // The session cookie is set. A full load reads the new state.
        window.location.reload();

        return null;
      })
      .catch((cause: unknown) => {
        setError(errorText(cause));
        setBusy(false);
      });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4.5">
      <Heading title="Protect it with a password">
        Use this if your account has no Zero Trust. One password opens the
        dashboard. Your API keys do not change.
      </Heading>
      <Field
        label="Password"
        hint={`${MIN_PASSWORD} characters or more`}
        error={short ? `Use ${MIN_PASSWORD} characters or more.` : undefined}
      >
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          invalid={short}
          autoComplete="new-password"
          autoFocus
          className="h-11 md:h-10"
        />
      </Field>
      <Field
        label="Password again"
        error={differ ? "The two passwords are not the same." : undefined}
      >
        <Input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          invalid={differ}
          autoComplete="new-password"
          className="h-11 md:h-10"
        />
      </Field>
      {error && (
        <Notice tone="red" icon="alert">
          {error}
        </Notice>
      )}
      <Button
        type="submit"
        variant="primary"
        icon="lock"
        busy={busy}
        disabled={password.length < MIN_PASSWORD || confirm !== password}
        className={wide}
      >
        set the password
      </Button>
    </form>
  );
}

// Access is set up. The Worker sees no identity yet.
function ThroughAccess({
  session,
  reload,
}: {
  session: Session;
  reload: () => Promise<void>;
}) {
  const host = session.api_hostname;

  return (
    <Layout hero={HERO.access} session={session}>
      <Heading title="Sign in through Access">
        This dashboard sits behind Cloudflare Access. Open it at its own
        hostname to sign in.
      </Heading>
      {host && (
        <ButtonLink
          href={`https://${host}/`}
          variant="primary"
          icon="login"
          className={wide}
        >
          continue to {host}
        </ButtonLink>
      )}
      <SmallLink onClick={() => void reload()}>check again</SmallLink>
    </Layout>
  );
}

// The wait in seconds from a 429 answer. The Worker sends `retry_after`.
function retryAfter(body: JsonValue): number {
  const v = isJsonObject(body) ? body.retry_after : undefined;

  return isNumber(v) && v > 0 ? v : 60;
}

function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);

  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function Password({ session }: { session: Session }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The end of the pause after a 429 answer, in ms.
  const [until, setUntil] = useState(0);
  const now = useNow(1000);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  const limited = left > 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api("/auth/login", { method: "POST", body: { password } })
      .then(() => {
        // The session cookie is set. A full load reads the new state.
        window.location.reload();

        return null;
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiRequestError && cause.status === 429) {
          const seconds = retryAfter(cause.body);
          setUntil(Date.now() + seconds * 1000);
          setError(
            `Too many attempts. Wait ${waitText(seconds)}, then try again.`,
          );
        } else setError(errorText(cause));
        setBusy(false);
      });
  }

  return (
    <Layout hero={limited ? HERO.limit : HERO.pw} session={session}>
      <Heading title="Sign in with password">
        Access is not set up on this deploy. We recommend it.
      </Heading>
      <form onSubmit={submit} className="flex flex-col gap-4.5">
        <Field label="Password" error={error && <>{error}</>}>
          <span className="relative flex">
            <Input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              invalid={Boolean(error)}
              autoComplete="current-password"
              autoFocus
              className="h-11 pr-11 md:h-10"
            />
            <button
              type="button"
              aria-label={show ? "Hide password" : "Show password"}
              aria-pressed={show}
              onClick={() => setShow(!show)}
              className="absolute top-0 right-0 grid size-11 place-items-center border-0 bg-transparent text-fg3 hover:text-fg md:size-10"
            >
              <Icon name={show ? "eye-closed" : "eye"} />
            </button>
          </span>
        </Field>
        <Button
          type="submit"
          variant="primary"
          icon={limited ? "clock" : "login"}
          busy={busy}
          disabled={!password || limited}
          className={wide}
        >
          {limited
            ? `wait ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`
            : "sign in"}
        </Button>
      </form>
    </Layout>
  );
}
