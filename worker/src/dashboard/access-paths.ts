import type { Env } from "../env";
import { type AccessApp, type AccessAppInput } from "../lib/cloudflare";
import type { Cloudflare } from "../lib/cloudflare";
import { setSettings } from "../lib/settings";
import { PUBLIC_PATHS } from "../public-paths";

export const API_APP_NAME = "fullsend API";

// The destinations of the "fullsend API" Access application: each public
// path and its subpaths.
export const apiDestinations = (hostname: string) =>
  PUBLIC_PATHS.flatMap((p) => [
    { type: "public", uri: `${hostname}${p}` },
    { type: "public", uri: `${hostname}${p}/*` },
  ]);

// The body of the create call for the "fullsend API" application.
export const apiAppInput = (hostname: string): AccessAppInput => ({
  name: API_APP_NAME,
  type: "self_hosted",
  domain: `${hostname}${PUBLIC_PATHS[0]}`,
  destinations: apiDestinations(hostname),
  app_launcher_visible: false,
  policies: [
    { name: "public", decision: "bypass", include: [{ everyone: {} }] },
  ],
});

// The application has the name of the API app and the hostname. Its
// `domain` is the hostname and the first path, or only the hostname.
export const isApiApp = (app: AccessApp, hostname: string): boolean =>
  app.name === API_APP_NAME &&
  (app.domain === hostname || app.domain?.startsWith(`${hostname}/`) === true);

// Remembers the paths that fullsend wrote.
export const rememberPaths = (env: Env): Promise<void> =>
  setSettings(env, { access_paths: PUBLIC_PATHS.join(",") });

// Sets the destinations of an existing application to the current public
// paths. The call replaces the application, so the body keeps its name,
// its type and its policies.
export async function syncApiApp(
  env: Env,
  cf: Cloudflare,
  app: AccessApp,
  hostname: string,
): Promise<void> {
  const full = await cf.accessApp(app.id);

  await cf.updateAccessApp(app.id, {
    name: full.name,
    type: full.type ?? "self_hosted",
    domain: `${hostname}${PUBLIC_PATHS[0]}`,
    destinations: apiDestinations(hostname),
    app_launcher_visible: full.app_launcher_visible ?? false,
    policies: (full.policies ?? []).map((p) => ({
      id: p.id,
      precedence: p.precedence,
    })),
  });

  await rememberPaths(env);
}
