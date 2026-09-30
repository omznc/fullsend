import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  useCallback,
  useSyncExternalStore,
} from "react";

// A small router on the History API. The filters of a list live in the
// query string, so a view can be shared.
//
// The dashboard pages live under BASE. The public API owns /emails,
// /domains, /api-keys and /webhooks, and Access lets those paths through
// without a sign-in. Screens use paths without BASE ("/emails/:id"); the
// router adds BASE to the URL and removes it from the location.
export const BASE = "/dashboard";

// True for a path that the Worker serves, not the dashboard.
const serverPath = (to: string) =>
  !to.startsWith("/") || /^\/(api|cdn-cgi)(\/|$)/.test(to);

// The URL in the address bar for a dashboard path.
export function toUrl(to: string): string {
  if (
    serverPath(to) ||
    to === BASE ||
    to.startsWith(`${BASE}/`) ||
    to.startsWith(`${BASE}?`)
  )
    return to;

  return to === "/" || to.startsWith("/?") ? BASE + to.slice(1) : BASE + to;
}

// A page outside BASE (the root after sign-in, or an old link) moves
// under BASE without a reload.
if (!serverPath(window.location.pathname)) {
  const url = toUrl(window.location.pathname) + window.location.search;

  if (url !== window.location.pathname + window.location.search)
    window.history.replaceState(null, "", url + window.location.hash);
}

const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  window.addEventListener("popstate", fn);

  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  const to = toUrl(path);

  if (to === snapshot()) return;

  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);

  for (const fn of listeners) fn();

  if (!opts.replace) window.scrollTo(0, 0);
}

export interface Location {
  path: string;
  query: URLSearchParams;
}

export function useLocation(): Location {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, window.location.origin);

  const path = url.pathname.startsWith(BASE)
    ? url.pathname.slice(BASE.length)
    : url.pathname;

  return {
    path: path.replace(/\/+$/, "") || "/",
    query: url.searchParams,
  };
}

// Matches a pattern like "/emails/:id". Returns the params or null.
export function match(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);

  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};

  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;

    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(b[i]!);
    else if (p !== b[i]) return null;
  }

  return params;
}

// Reads and writes the query string of the current page.
export function useQuery(): [
  URLSearchParams,
  (patch: Record<string, string | null | undefined>) => void,
] {
  const { path, query } = useLocation();

  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(window.location.search);

      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }

      const s = next.toString();
      navigate(`${path}${s ? `?${s}` : ""}`, { replace: true });
    },
    [path],
  );

  return [query, set];
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

// An anchor that changes the page without a reload. A modified click
// (new tab, new window) keeps the browser behavior.
export function Link({ href, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);

    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      rest.target ||
      serverPath(href)
    )
      return;
    e.preventDefault();
    navigate(href);
  };

  return <a href={toUrl(href)} onClick={handle} {...rest} />;
}
