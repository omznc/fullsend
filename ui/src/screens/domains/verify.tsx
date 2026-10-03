import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Domain, type DomainRecord } from "../../api";
import { errorText, Icon } from "../../components/ui";
import { useInterval, useNow } from "../../lib/hooks";

// The client checks DNS while a page is open. The Worker cron also syncs
// each domain every 15 minutes, so a closed page does not stop the check.
const FAST_MS = 10_000;

const SLOW_MS = 60_000;

const FAST_WINDOW_MS = 5 * 60_000;

interface Run {
  startedAt: number;
  nextAt: number;
  attempts: number;
}

export interface VerifyPoll {
  // True while a check runs.
  busy: boolean;
  // True from the first check until the domain is verified.
  active: boolean;
  attempts: number;
  // The time of the next check, in ms since the epoch.
  nextAt: number | null;
  error: string | null;
  start: () => void;
}

// Calls POST /domains/:id/verify each 10 s for 5 minutes, then each 60 s.
// The polling stops when the domain is verified or the page closes.
// With `autoStart`, the first check runs at once.
export function useVerifyPoll(
  id: string,
  onDomain: (d: Domain) => void,
  autoStart = false,
): VerifyPoll {
  const [run, setRun] = useState<Run | null>(() =>
    autoStart
      ? { startedAt: Date.now(), nextAt: Date.now(), attempts: 0 }
      : null,
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const runRef = useRef<Run | null>(run);
  useEffect(() => {
    runRef.current = run;
  });

  const check = useCallback(
    (fresh?: boolean) => {
      const base = fresh
        ? { startedAt: Date.now(), nextAt: 0, attempts: 0 }
        : runRef.current;

      if (inflight.current || !base) return;
      inflight.current = true;
      setBusy(true);
      api<Domain>(`/domains/${encodeURIComponent(id)}/verify`, {
        method: "POST",
      })
        .then(
          (d) => {
            setError(null);
            onDomain(d);

            return d.status === "verified";
          },
          (cause: unknown) => {
            setError(errorText(cause));

            return false;
          },
        )
        .then((done) => {
          inflight.current = false;
          setBusy(false);
          const now = Date.now();
          setRun(
            done
              ? null
              : {
                  startedAt: base.startedAt,
                  attempts: base.attempts + 1,
                  nextAt:
                    now +
                    (now - base.startedAt < FAST_WINDOW_MS ? FAST_MS : SLOW_MS),
                },
          );

          return undefined;
        });
    },
    [id, onDomain],
  );

  useInterval(() => {
    const r = runRef.current;

    if (r && Date.now() >= r.nextAt) check();
  }, 1000);

  return {
    busy,
    active: run !== null || busy,
    attempts: run?.attempts ?? 0,
    nextAt: run?.nextAt ?? null,
    error,
    start: () => check(true),
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

// The state of the DNS check: records found, countdown, attempt count.
export function VerifyBanner({
  records,
  poll,
}: {
  records: DomainRecord[];
  poll: VerifyPoll;
}) {
  const now = useNow(1000);
  const found = records.filter((r) => r.status === "verified").length;

  const left = poll.nextAt
    ? Math.max(0, Math.ceil((poll.nextAt - now) / 1000))
    : null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border border-line2 px-3 py-2.5"
    >
      <Icon
        name="loader"
        className={poll.busy ? "animate-spin text-accent-fg" : "text-accent-fg"}
      />
      <span className="flex-1">
        {found} of {records.length} records found
      </span>
      <span className="font-mono text-[12px] text-fg3">
        {poll.busy ? "checking" : left !== null ? `next check ${left} s` : ""}
        {poll.attempts > 0 && ` · attempt ${poll.attempts}`}
      </span>
      {poll.error && (
        <span className="basis-full text-[12.5px] text-red">{poll.error}</span>
      )}
    </div>
  );
}
