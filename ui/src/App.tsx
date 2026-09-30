import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api, type Session } from "./api";
import { Shell } from "./components/Shell";
import { EmptyState, ErrorState, Logo, TextLink } from "./components/ui";
import { match, useLocation } from "./lib/router";
import { ApiKeys } from "./screens/ApiKeys";
import { Docs } from "./screens/Docs";
import { DomainDetail } from "./screens/DomainDetail";
import { Domains } from "./screens/Domains";
import { EmailDetail } from "./screens/EmailDetail";
import { Emails } from "./screens/Emails";
import { Login } from "./screens/Login";
import { Overview } from "./screens/Overview";
import { Playground } from "./screens/Playground";
import { Settings } from "./screens/Settings";
import { Suppressions } from "./screens/Suppressions";
import { WebhookDetail } from "./screens/WebhookDetail";
import { Webhooks } from "./screens/Webhooks";
import { Wizard } from "./screens/Wizard";
import { SessionContext } from "./session";

type Route = [string, (p: Record<string, string>) => ReactNode];

const ROUTES: Route[] = [
  ["/", () => <Overview />],
  ["/emails", () => <Emails />],
  ["/emails/:id", (p) => <EmailDetail key={p.id} id={p.id!} />],
  ["/domains", () => <Domains />],
  ["/domains/:id", (p) => <DomainDetail key={p.id} id={p.id!} />],
  ["/api-keys", () => <ApiKeys />],
  ["/webhooks", () => <Webhooks />],
  ["/webhooks/:id", (p) => <WebhookDetail key={p.id} id={p.id!} />],
  ["/suppressions", () => <Suppressions />],
  ["/playground", () => <Playground />],
  ["/docs", () => <Docs />],
  ["/settings", () => <Settings />],
];

function Routes() {
  const { path } = useLocation();

  for (const [pattern, render] of ROUTES) {
    const params = match(pattern, path);

    if (params) return <>{render(params)}</>;
  }

  return (
    <EmptyState
      icon="alert"
      title="This page does not exist"
      action={<TextLink href="/">Go to the overview</TextLink>}
    />
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { path } = useLocation();

  const reload = useCallback(async () => {
    try {
      setSession(await api<Session>("/session"));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    api<Session>("/session").then(setSession, setError);
  }, []);

  if (error && !session)
    return (
      <div className="flex min-h-screen flex-col">
        <div className="border-b border-line px-5 py-3">
          <Logo />
        </div>
        <ErrorState
          error={error}
          title="Could not reach fullsend"
          onRetry={() => void reload()}
        />
      </div>
    );

  if (!session) return null;

  const value = { session, reload };

  if (session.state !== "ready")
    return (
      <SessionContext.Provider value={value}>
        <Login session={session} reload={reload} />
      </SessionContext.Provider>
    );

  return (
    <SessionContext.Provider value={value}>
      {path === "/setup" || path.startsWith("/setup/") ? (
        <Wizard />
      ) : (
        <Shell>
          <Routes />
        </Shell>
      )}
    </SessionContext.Provider>
  );
}
