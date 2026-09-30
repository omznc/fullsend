import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, type SearchResult } from "../api";
import { useNarrow } from "../lib/hooks";
import { Link, navigate, toUrl, useLocation } from "../lib/router";
import { apiBase, useSession } from "../session";
import { Badge, CopyButton, cx, Icon, IconButton, Kbd, Logo } from "./ui";

export const NAV: { label: string; href: string; icon: string }[] = [
  { label: "overview", href: "/", icon: "dashbaord" },
  { label: "emails", href: "/emails", icon: "mail" },
  { label: "domains", href: "/domains", icon: "server" },
  { label: "api keys", href: "/api-keys", icon: "lock" },
  { label: "webhooks", href: "/webhooks", icon: "link" },
  { label: "suppressions", href: "/suppressions", icon: "mail-off" },
  { label: "playground", href: "/playground", icon: "code" },
  { label: "docs", href: "/docs", icon: "book-open" },
  { label: "settings", href: "/settings", icon: "sliders" },
];

function current(path: string): string {
  const hit = NAV.filter((n) =>
    n.href === "/" ? path === "/" : path.startsWith(n.href),
  );

  return hit.at(-1)?.href ?? "";
}

// The top bar and the nav. Below 768 px the nav collapses to a menu.
export function Shell({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const { path } = useLocation();
  const narrow = useNarrow();
  // The menu is open for one path. A new page closes it.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menu = menuFor === path;
  const [search, setSearch] = useState(false);
  const active = current(path);
  const base = apiBase(session);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch(true);

        return;
      }

      const t = e.target;

      const typing =
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

      if (e.key === "/" && !typing) {
        const list =
          document.querySelector<HTMLInputElement>("[data-list-search]");

        e.preventDefault();

        if (list) list.focus();
        else setSearch(true);
      }
    };

    window.addEventListener("keydown", fn);

    return () => window.removeEventListener("keydown", fn);
  }, []);

  const identity = session.identity ?? "";

  const signOut = (
    <a
      href={session.logout_url}
      aria-label="Sign out"
      title="Sign out"
      onClick={async (e) => {
        if (session.logout_url.startsWith("/api/")) {
          e.preventDefault();
          await api("/auth/logout", { method: "POST" }).catch(() => {});
          window.location.href = "/";
        }
      }}
      className={cx(
        "grid place-items-center text-fg2 hover:text-fg",
        narrow ? "size-11" : "size-8",
      )}
    >
      <Icon name="logout" size={16} />
    </a>
  );

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-accent focus:p-2 focus:text-accent-ink"
      >
        Skip to content
      </a>
      {narrow ? (
        <div className="sticky top-0 z-30 bg-bg font-mono text-[13px]">
          <div className="flex h-[52px] items-center justify-between border-b border-line pr-1 pl-4">
            <Link href="/" className="no-underline">
              <Logo />
            </Link>
            <div className="flex">
              <IconButton
                icon="search"
                label="Search"
                size={44}
                className="text-fg"
                onClick={() => setSearch(true)}
              />
              <IconButton
                icon={menu ? "close" : "menu"}
                label="Menu"
                aria-expanded={menu}
                size={44}
                className="text-fg"
                onClick={() => setMenuFor(menu ? null : path)}
              />
            </div>
          </div>
          {menu && (
            <nav
              aria-label="Main"
              className="fixed inset-x-0 top-[52px] bottom-0 z-30 flex flex-col overflow-y-auto bg-bg"
            >
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={n.href === active ? "page" : undefined}
                  className={cx(
                    "flex min-h-12 items-center gap-2.5 border-b border-line px-4 no-underline",
                    n.href === active
                      ? "bg-raised text-fg shadow-[inset_3px_0_0_var(--accent)]"
                      : "text-fg3",
                  )}
                >
                  <Icon name={n.icon} />
                  {n.label}
                </Link>
              ))}
              <div className="flex-1" />
              <div className="flex min-h-12 items-center justify-between border-t border-line pr-1 pl-4 text-fg2">
                <span className="min-w-0 truncate">{base}</span>
                <CopyButton text={base} label="Copy Worker URL" size={44} />
              </div>
              <div className="flex min-h-12 items-center justify-between border-t border-line pr-1 pl-4 text-fg2">
                <span className="flex min-w-0 items-center gap-2">
                  <Icon name="shield" className="text-green" />
                  <span className="truncate">{identity}</span>
                </span>
                {signOut}
              </div>
            </nav>
          )}
        </div>
      ) : (
        <div className="font-mono text-[12.5px]">
          <div className="flex h-11 items-stretch border-b border-line">
            <Link
              href="/"
              className="flex items-center border-r border-line px-5 no-underline"
            >
              <Logo />
            </Link>
            <button
              type="button"
              onClick={() => setSearch(true)}
              className="flex w-[360px] items-center gap-2 border-0 border-r border-line bg-transparent pr-3 pl-2.5 text-left font-mono text-[12.5px] text-fg3 hover:text-fg2"
            >
              <Icon name="search" size={16} />
              <span className="flex-1">search emails, domains, keys</span>
              <Kbd>
                <Icon name="command" size={16} />K
              </Kbd>
            </button>
            <span className="flex-1" />
            <div className="flex min-w-0 items-center gap-1.5 border-l border-line pr-2 pl-4 text-fg2">
              <span className="text-fg3">worker</span>
              <span className="max-w-[280px] truncate">{base}</span>
              <CopyButton text={base} label="Copy Worker URL" />
            </div>
            <div className="flex min-w-0 items-center gap-1.5 border-l border-line pr-2 pl-4 text-fg2">
              <Icon name="shield" className="text-green" />
              <span className="max-w-[220px] truncate">{identity}</span>
              {signOut}
            </div>
          </div>
          <nav
            aria-label="Main"
            className="flex h-11 items-stretch overflow-x-auto border-b border-line pl-2"
          >
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.href === active ? "page" : undefined}
                className={cx(
                  "flex shrink-0 items-center gap-1.5 px-3 no-underline hover:text-fg",
                  n.href === active
                    ? "text-fg shadow-[inset_0_-2px_0_var(--accent)]"
                    : "text-fg3",
                )}
              >
                <Icon name={n.icon} />
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
      <main id="main" className="flex min-w-0 flex-1 flex-col">
        {children}
      </main>
      {search && <CommandPalette onClose={() => setSearch(false)} />}
    </div>
  );
}

interface Item {
  group: string;
  icon: string;
  label: string;
  href: string;
  mono?: boolean;
  meta?: ReactNode;
}

// Cmd+K. An exact id jumps straight to the item. Otherwise the results
// group into emails, domains, keys, webhooks and pages.
function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");

  const [found, setFound] = useState<{
    term: string;
    data: SearchResult;
  } | null>(null);

  const [sel, setSel] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    const term = q.trim();

    if (term.length < 2) return;
    const ctl = new AbortController();

    const t = setTimeout(async () => {
      try {
        const data = await api<SearchResult>(
          `/search?q=${encodeURIComponent(term)}`,
          { signal: ctl.signal },
        );

        setFound({ term, data });
        setSel(0);
      } catch {
        // A new term aborted the request, or the search failed.
      }
    }, 150);

    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const term = q.trim().toLowerCase();

  const result =
    found && found.term.toLowerCase() === term && term.length >= 2
      ? found.data
      : null;

  const items: Item[] = [
    ...(result?.emails ?? []).map((e) => ({
      group: "Emails",
      icon: "mail",
      label: e.subject || "(no subject)",
      href: `/emails/${e.id}`,
      meta: <Badge status={e.status} />,
    })),
    ...(result?.domains ?? []).map((d) => ({
      group: "Domains",
      icon: "server",
      label: d.name,
      href: `/domains/${d.id}`,
      mono: true,
      meta: <Badge status={d.status} />,
    })),
    ...(result?.api_keys ?? []).map((k) => ({
      group: "Api keys",
      icon: "lock",
      label: k.name,
      href: `/api-keys?key=${k.id}`,
      mono: true,
      meta: <span className="font-mono text-[12px] text-fg3">{k.prefix}…</span>,
    })),
    ...(result?.webhooks ?? []).map((w) => ({
      group: "Webhooks",
      icon: "link",
      label: w.endpoint,
      href: `/webhooks/${w.id}`,
      mono: true,
      meta: <Badge status={w.status} />,
    })),
    ...NAV.flatMap((n) =>
      term && n.label.includes(term)
        ? [{ group: "Pages", icon: n.icon, label: n.label, href: n.href }]
        : [],
    ),
  ];

  // An exact id opens the item at once.
  useEffect(() => {
    const exact = found?.data.emails.find((e) => e.id === found.term);

    if (exact) {
      onClose();
      navigate(`/emails/${exact.id}`);
    }
  }, [found, onClose]);

  const open = (item: Item, newTab: boolean) => {
    if (newTab) window.open(toUrl(item.href), "_blank");
    else {
      onClose();
      navigate(item.href);
    }
  };

  let lastGroup = "";

  return (
    <dialog
      ref={dialog}
      aria-label="Search"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
      className="mx-auto mt-[12vh] w-[calc(100vw-32px)] max-w-[560px] border border-line2 bg-bg p-0 text-fg shadow-[0_20px_50px_var(--shadow)] backdrop:bg-black/50"
    >
      <div className="flex h-12 items-center gap-2 border-b border-line px-3">
        <Icon name="search" className="text-fg3" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter" && items[sel]) {
              e.preventDefault();
              open(items[sel]!, e.metaKey || e.ctrlKey);
            }
          }}
          placeholder="Search emails, domains, keys, webhooks"
          aria-label="Search"
          className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg3"
        />
        <Kbd>esc</Kbd>
      </div>
      <div role="listbox" className="max-h-[50vh] overflow-y-auto py-1.5">
        {items.length === 0 && (
          <div className="px-3.5 py-3 text-fg3">
            {term.length < 2
              ? "Type two letters or more, or paste an email id."
              : result
                ? "Nothing matches."
                : "Searching…"}
          </div>
        )}
        {items.map((item, i) => {
          const head = item.group !== lastGroup;
          lastGroup = item.group;

          return (
            <div key={`${item.group}-${item.href}`}>
              {head && (
                <div className="px-3.5 pt-2 pb-1 text-[12.5px] text-fg3">
                  {item.group}
                </div>
              )}
              <div
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={(e) => open(item, e.metaKey || e.ctrlKey)}
                className={cx(
                  "flex cursor-pointer items-center gap-2 px-3.5 py-1.5",
                  i === sel && "bg-raised shadow-[inset_3px_0_0_var(--accent)]",
                )}
              >
                <Icon
                  name={item.icon}
                  className={i === sel ? undefined : "text-fg2"}
                />
                <span
                  className={cx(
                    "min-w-0 flex-1 truncate",
                    item.mono && "font-mono text-[12.5px]",
                  )}
                >
                  {item.label}
                </span>
                {item.meta}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3.5 border-t border-line px-3.5 py-2 font-mono text-[11px] text-fg3">
        <span>up/down move</span>
        <span>enter open</span>
        <span>cmd+enter new tab</span>
        <span>paste an email id to jump</span>
      </div>
    </dialog>
  );
}
