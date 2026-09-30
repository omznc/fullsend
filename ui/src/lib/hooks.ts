import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

type Updater<T> = (prev: T | null) => T;

// A function argument to setData is an updater. The data of a resource is
// JSON, and JSON is never a function.
function isUpdater<T>(fn: T | Updater<T>): fn is Updater<T> {
  return typeof fn === "function";
}

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  // True after 150 ms without data. A fast load never shows a skeleton.
  loading: boolean;
  reload: () => Promise<void>;
  setData: (fn: T | Updater<T>) => void;
}

interface Loaded<T> {
  key: string | null;
  data: T | null;
  error: Error | null;
}

// Loads a dashboard API path. A null path loads nothing. The data stays
// on screen while a reload runs.
export function useApi<T>(path: string | null): Resource<T> {
  const [state, setState] = useState<Loaded<T>>({
    key: null,
    data: null,
    error: null,
  });

  const [slowKey, setSlowKey] = useState<string | null>(null);
  const seq = useRef(0);

  // Starts a request for p. The newest request wins. The state changes
  // only in the promise callbacks, never at once.
  const start = useCallback((p: string): Promise<void> => {
    const id = ++seq.current;

    const timer = setTimeout(() => {
      if (id === seq.current) setSlowKey(p);
    }, 150);

    return api<T>(p)
      .then(
        (body) =>
          id === seq.current && setState({ key: p, data: body, error: null }),
        (err: Error) =>
          id === seq.current &&
          setState((s) => ({
            key: p,
            data: s.key === p ? s.data : null,
            error: err,
          })),
      )
      .then(() => clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (path) void start(path).then(() => undefined);
  }, [path, start]);

  const current = state.key === path;

  const reload = useCallback(
    () => (path ? start(path) : Promise.resolve()),
    [path, start],
  );

  const setData = useCallback(
    (fn: T | Updater<T>) =>
      setState((s) => {
        const prev = s.key === path ? s.data : null;

        return {
          key: path,
          data: isUpdater(fn) ? fn(prev) : fn,
          error: null,
        };
      }),
    [path],
  );

  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: Boolean(path) && !current && slowKey === path,
    reload,
    setData,
  };
}

// The current time. It changes each minute, so relative times update.
export function useNow(interval = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);

    return () => clearInterval(t);
  }, [interval]);

  return now;
}

// Calls fn at an interval while `active` is true.
export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    if (ms === null) return;
    const t = setInterval(() => ref.current(), ms);

    return () => clearInterval(t);
  }, [ms]);
}

// True when the viewport is narrower than the breakpoint.
export function useNarrow(px = 768): boolean {
  const query = `(max-width: ${px - 1}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setNarrow(m.matches);
    m.addEventListener("change", fn);

    return () => m.removeEventListener("change", fn);
  }, [query]);

  return narrow;
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · fullsend` : "fullsend";
  }, [title]);
}
