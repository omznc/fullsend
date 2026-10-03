import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Domain, type DomainRecord } from "../../api";
import { Button, errorText, Icon } from "../../components/ui";
import { usePoll } from "../../lib/hooks";

// The client checks DNS while a page is open and visible. The fast checks
// stop after 5 minutes. The Worker cron also syncs each domain every 15
// minutes, so a stopped page does not stop the check.
const FAST_MS = 10_000;

const FAST_WINDOW_MS = 5 * 60_000;

// "running": the fast checks go on. "stopped": the 5 minutes ended. "idle":
// no check runs, or the domain is verified or failed.
type Phase = "idle" | "running" | "stopped";

export interface VerifyPoll {
  // True while a check runs.
  busy: boolean;
  // True while the fast checks run.
  active: boolean;
  // True when the fast checks ended and the domain is not final.
  stopped: boolean;
  attempts: number;
  error: string | null;
  // Starts a new run of fast checks, with one check at once.
  start: () => void;
}

// Calls POST /domains/:id/verify each 10 s for 5 minutes while the tab is
// visible. It stops when the domain is verified or failed, when the 5
// minutes end, or when the page closes. With `autoStart`, the first check
// runs at once.
export function useVerifyPoll(
  id: string,
  onDomain: (d: Domain) => void,
  autoStart = false,
): VerifyPoll {
  const [phase, setPhase] = useState<Phase>(autoStart ? "running" : "idle");
  const [attempts, setAttempts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const startedAt = useRef(0);

  const check = useCallback(
    (fresh: boolean): Promise<void> => {
      if (inflight.current) return Promise.resolve();
      inflight.current = true;

      if (fresh || startedAt.current === 0) startedAt.current = Date.now();
      setBusy(true);

      return api<Domain>(`/domains/${encodeURIComponent(id)}/verify`, {
        method: "POST",
      })
        .then(
          (d) => {
            setError(null);
            onDomain(d);

            return d.status === "verified" || d.status === "failed";
          },
          (cause: unknown) => {
            setError(errorText(cause));

            return false;
          },
        )
        .then((final) => {
          inflight.current = false;
          setBusy(false);
          setAttempts((n) => (fresh ? 0 : n) + 1);

          if (final) setPhase("idle");
          else if (Date.now() - startedAt.current >= FAST_WINDOW_MS)
            setPhase("stopped");
          else setPhase("running");

          return undefined;
        });
    },
    [id, onDomain],
  );

  const first = useRef(autoStart);
  useEffect(() => {
    if (!first.current) return;
    first.current = false;
    void check(true);
  }, [check]);

  usePoll(() => check(false), phase === "running" ? FAST_MS : null);

  return {
    busy,
    active: phase === "running",
    stopped: phase === "stopped",
    attempts,
    error,
    start: () => void check(true),
  };
}

// The icon name and the text color for the status of a DNS record.
interface RecordIcon {
  name: string;
  color: string;
}

export function recordIcon(status: string): RecordIcon {
  if (status === "verified") return { name: "check", color: "text-green" };

  if (status === "failed") return { name: "close", color: "text-red" };

  return { name: "clock", color: "text-amber" };
}

// The state of the DNS check: records found, check rate, attempt count.
// After the fast checks stop, it tells that the cron checks each 15 minutes
// and offers a check now.
export function VerifyBanner({
  records,
  poll,
}: {
  records: DomainRecord[];
  poll: VerifyPoll;
}) {
  const found = records.filter((r) => r.status === "verified").length;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border border-line2 px-3 py-2.5"
    >
      <Icon
        name={poll.stopped && !poll.busy ? "clock" : "loader"}
        className={
          poll.busy
            ? "animate-spin text-accent-fg"
            : poll.stopped
              ? "text-fg3"
              : "text-accent-fg"
        }
      />
      <span className="flex-1">
        {found} of {records.length} records found
      </span>
      <span className="font-mono text-[12px] text-fg3">
        {poll.busy
          ? "checking"
          : poll.stopped
            ? "stopped"
            : "checks every 10 s"}
        {poll.attempts > 0 && ` · attempt ${poll.attempts}`}
      </span>
      {poll.stopped && (
        <>
          <span className="basis-full text-[12.5px] text-fg2">
            The fast checks stopped. fullsend checks again every 15 minutes.
          </span>
          <Button icon="reload" busy={poll.busy} onClick={poll.start}>
            check now
          </Button>
        </>
      )}
      {poll.error && (
        <span className="basis-full text-[12.5px] text-red">{poll.error}</span>
      )}
    </div>
  );
}
