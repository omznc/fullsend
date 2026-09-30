import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Domain, type SetupState } from "../api";
import {
  cx,
  ErrorState,
  Icon,
  IconButton,
  Logo,
  SkeletonBlock,
  useToast,
} from "../components/ui";
import { useApi, useNarrow, useTitle } from "../lib/hooks";
import { Link, navigate, useLocation } from "../lib/router";
import {
  StepCloudflare,
  StepDns,
  StepDomain,
  StepEvents,
} from "./wizard/early";
import { StepDone, StepHostnames, StepKey, StepTest } from "./wizard/late";
import type { Flow, Poll } from "./wizard/parts";

// The setup wizard. It draws its own chrome and lives outside the nav.
// The step is in the URL: /setup/1 to /setup/8.

const STEPS = [
  [
    "Cloudflare connection",
    "token and account",
    "Can fullsend reach your Cloudflare account?",
    "fullsend needs a Cloudflare API token to set up email for you.",
  ],
  [
    "Sending domain",
    "zone and name",
    "Which domain will your email come from?",
    "Pick a zone you own, then the name people see after the @.",
  ],
  [
    "DNS records",
    "verify",
    "Prove you own the domain.",
    "Cloudflare adds most of these records for you. Anything left is shown with a copy button.",
  ],
  [
    "Delivery events",
    "optional",
    "Hear back when email arrives or bounces.",
    "Cloudflare reports each delivery, bounce and spam report back to fullsend.",
  ],
  [
    "Hostnames",
    "api and tracking",
    "Give your API and tracking links a home.",
    "fullsend attaches both to your Worker as custom domains. Your apps call the API hostname. Open and click links use the tracking hostname.",
  ],
  [
    "First API key",
    "for your app",
    "Make a key for your app.",
    "Your app sends this key with every request. It shows once, so copy it now.",
  ],
  [
    "Test email",
    "optional",
    "Send yourself one email.",
    "Watch it travel from queued to delivered, live.",
  ],
  [
    "Done",
    "snippets",
    "You are ready to send.",
    "Point your Resend SDK at this deploy. Only the base URL and the key change.",
  ],
] as const;

const FAST = 10_000;

const SLOW = 60_000;

const FAST_SPAN = 5 * 60_000;

const GIVE_UP = 30 * 60_000;

function stepOf(path: string): number {
  const n = Number(path.split("/")[2]);

  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 1;
}

// Verifies the domain in a loop: every 10 s for 5 minutes, then every
// 60 s, and it gives up after 30 minutes. The server has no background
// verify, so the loop runs here and ends when the wizard closes.
function useVerify(
  onDomain: (d: Domain) => void,
  onReady: (d: Domain) => void,
): Poll {
  const [state, setState] = useState<Omit<Poll, "start">>({
    phase: "idle",
    attempt: 0,
    nextAt: null,
    busy: false,
  });

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const gen = useRef(0);
  const cbs = useRef({ onDomain, onReady });
  useEffect(() => {
    cbs.current = { onDomain, onReady };
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const start = useCallback((id: string) => {
    clearTimeout(timer.current);
    const mine = ++gen.current;
    const began = Date.now();
    let attempt = 0;

    const tick = async (): Promise<void> => {
      attempt += 1;
      setState((s) => ({
        ...s,
        phase: "running",
        attempt,
        nextAt: null,
        busy: true,
      }));
      let domain: Domain | null = null;

      try {
        domain = await api<Domain>(`/domains/${id}/verify`, { method: "POST" });
      } catch {
        // A failed request counts as one attempt. The loop goes on.
      }

      if (mine !== gen.current) return;

      if (domain) cbs.current.onDomain(domain);

      if (domain?.status === "verified") {
        cbs.current.onReady(domain);
        setState({ phase: "done", attempt, nextAt: null, busy: false });

        return;
      }

      const spent = Date.now() - began;

      if (spent >= GIVE_UP) {
        setState({ phase: "failed", attempt, nextAt: null, busy: false });

        return;
      }

      const wait = spent < FAST_SPAN ? FAST : SLOW;
      setState({
        phase: "running",
        attempt,
        nextAt: Date.now() + wait,
        busy: false,
      });
      timer.current = setTimeout(() => void tick(), wait);
    };

    void tick();
  }, []);

  return { ...state, start };
}

export function Wizard() {
  const { path } = useLocation();
  const step = stepOf(path);
  const narrow = useNarrow();
  const toast = useToast();
  const state = useApi<SetupState>("/setup/state");
  const [made, setMade] = useState<Domain | null>(null);

  const [hostnames, setHostnames] = useState<Flow["hostnames"]>({
    api: null,
    tracking: null,
  });

  const [key, setKey] = useState<Flow["key"]>(null);
  const [tested, setTested] = useState(false);
  const cur = STEPS[step - 1]!;
  useTitle(`Setup, step ${step}`);

  const domain = made ?? state.data?.domains[0] ?? null;

  const poll = useVerify(setMade, (d) =>
    toast({
      tone: "success",
      message: `${d.name} is ready to send.`,
    }),
  );

  const go = useCallback(
    (n: number) => navigate(n < 1 ? "/" : `/setup/${Math.min(8, n)}`),
    [],
  );

  const flow: Flow = {
    step,
    narrow,
    go,
    tokenSet: state.data?.cloudflare_token_set ?? false,
    domain,
    setDomain: setMade,
    poll,
    hostnames,
    setHostnames,
    key,
    setKey,
    tested,
    setTested,
  };

  const pad = narrow ? "px-4" : "px-8";

  return (
    <div className="flex min-h-screen flex-col bg-bg font-sans text-[14px] leading-[21px] text-fg">
      <header
        className={cx(
          "flex h-12 items-center justify-between border-b border-line pr-1 font-mono text-[12.5px]",
          narrow ? "pl-4" : "pl-8",
        )}
      >
        <span className="flex items-baseline gap-1">
          <Logo />
          <span className="text-fg3">/ setup</span>
        </span>
        <span className="flex items-center gap-2 text-fg2">
          step {step} of 8
          <IconButton
            icon="close"
            label="Exit setup"
            size={44}
            onClick={() => navigate("/")}
          />
        </span>
      </header>
      <div className="grid grid-cols-8 gap-0.5" aria-hidden="true">
        {STEPS.map((_, i) => (
          <span
            key={i}
            className={cx(
              "h-1 transition-colors duration-300 ease-out",
              i + 1 < step
                ? "bg-green"
                : i + 1 === step
                  ? "bg-accent"
                  : "bg-line2",
            )}
          />
        ))}
      </div>
      <div
        className={cx(
          "grid flex-1",
          narrow
            ? "grid-cols-[minmax(0,1fr)]"
            : "grid-cols-[280px_minmax(0,1fr)]",
        )}
      >
        {!narrow && (
          <ol className="m-0 list-none border-r border-line p-0">
            {STEPS.map(([title, sub], i) => {
              const n = i + 1;
              const done = n < step;
              const here = n === step;

              const inner = (
                <>
                  <span className="grid w-6 place-items-center font-mono text-[12px] font-semibold">
                    {done ? (
                      <Icon name="check" className="text-green" />
                    ) : (
                      <span className={here ? "text-accent-fg" : "text-fg3"}>
                        {n}
                      </span>
                    )}
                  </span>
                  <span className="flex flex-col">
                    <span
                      className={cx(
                        "font-medium",
                        here || done ? "text-fg" : "text-fg2",
                      )}
                    >
                      {title}
                    </span>
                    <span className="font-mono text-[11.5px] text-fg3">
                      {done ? "done" : sub}
                    </span>
                  </span>
                </>
              );

              const cls = cx(
                "flex min-h-14 items-center gap-3 border-b border-line px-6 text-fg no-underline",
                here && "bg-panel shadow-[inset_3px_0_0_var(--accent)]",
              );

              return (
                <li key={title} aria-current={here ? "step" : undefined}>
                  {done ? (
                    <Link
                      href={`/setup/${n}`}
                      className={cx(cls, "hover:bg-hover")}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className={cls}>{inner}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {/* Each step fades in. The key mounts the section again. */}
        <section key={step} className="fs-enter flex min-w-0 flex-col">
          <div
            className={cx(
              "flex flex-col gap-1.5 border-b border-line",
              narrow ? "px-4 py-5" : "px-8 pt-7 pb-5.5",
            )}
          >
            <h1
              className={cx(
                "m-0 leading-tight font-semibold tracking-[-0.02em]",
                narrow ? "text-[22px]" : "text-[28px]",
              )}
            >
              {cur[2]}
            </h1>
            <p className="m-0 max-w-[640px] text-fg2">{cur[3]}</p>
          </div>
          {state.error ? (
            <ErrorState
              error={state.error}
              title="Could not load the setup state"
              onRetry={() => void state.reload()}
              className={pad}
            />
          ) : !state.data ? (
            <div
              aria-busy="true"
              className={cx("flex flex-col gap-3 py-5", pad)}
            >
              <SkeletonBlock className="h-12" />
              <SkeletonBlock className="h-10" />
              <SkeletonBlock className="h-10" />
            </div>
          ) : step === 1 ? (
            <StepCloudflare flow={flow} />
          ) : step === 2 ? (
            <StepDomain flow={flow} />
          ) : step === 3 ? (
            <StepDns flow={flow} />
          ) : step === 4 ? (
            <StepEvents flow={flow} />
          ) : step === 5 ? (
            <StepHostnames flow={flow} />
          ) : step === 6 ? (
            <StepKey flow={flow} />
          ) : step === 7 ? (
            <StepTest flow={flow} />
          ) : (
            <StepDone flow={flow} />
          )}
        </section>
      </div>
    </div>
  );
}
