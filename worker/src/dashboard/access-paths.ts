import { z } from "zod";
import type { Env } from "../env";
import {
  type AccessApp,
  type AccessAppInput,
  type AccessAppUpdate,
  CloudflareError,
} from "../lib/cloudflare";
import type { Cloudflare } from "../lib/cloudflare";
import { isJsonObject, type JsonObject, type JsonValue } from "../lib/json";
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

// The sync failed. The message is for the owner. It says if the old
// application is back.
export class AccessSyncError extends Error {}

// The fields of a Self Hosted application that the PUT call accepts. The
// PUT body must hold each field that the GET returns, so the sync copies
// all of them. Other fields are read-only (id, uid, aud, created_at,
// updated_at) and the PUT schema rejects them. `self_hosted_domains` is
// not copied: `destinations` replaces it.
// `domain`, `destinations`, `policies`, `name` and `type` are set apart.
const APP_FIELDS = [
  "allow_authenticate_via_warp",
  "allow_iframe",
  "allowed_idps",
  "app_launcher_visible",
  "auto_redirect_to_identity",
  "cors_headers",
  "custom_deny_message",
  "custom_deny_url",
  "custom_non_identity_deny_url",
  "custom_pages",
  "eager_redirect_cookie_setting",
  "enable_binding_cookie",
  "http_only_cookie_attribute",
  "logo_url",
  "mfa_config",
  "oauth_configuration",
  "options_preflight_bypass",
  "path_cookie_attribute",
  "read_service_tokens_from_header",
  "same_site_cookie_attribute",
  "scim_config",
  "service_auth_401_redirect",
  "session_duration",
  "skip_interstitial",
  "tags",
  "use_clientless_isolation_app_launcher_url",
] as const;

// The fields of an application-scoped policy that the PUT call accepts.
// `reusable`, `uid`, `app_count`, `created_at` and `updated_at` are
// read-only.
const POLICY_FIELDS = [
  "id",
  "precedence",
  "name",
  "decision",
  "include",
  "exclude",
  "require",
  "approval_groups",
  "approval_required",
  "connection_rules",
  "isolation_required",
  "mfa_config",
  "purpose_justification_prompt",
  "purpose_justification_required",
  "session_duration",
] as const;

const DESTINATION_FIELDS = [
  "type",
  "uri",
  "overrides",
  "mcp_server_id",
  "worker_id",
  "cidr",
  "hostname",
  "l4_protocol",
  "port_range",
  "vnet_id",
] as const;

const policySchema = z.object({
  id: z.string(),
  precedence: z.number().nullish(),
  decision: z.string().nullish(),
  include: z.array(z.looseObject({})).nullish(),
  reusable: z.boolean().nullish(),
});

const appSchema = z.object({
  name: z.string(),
  domain: z.string(),
  policies: z.array(policySchema).nullish(),
  destinations: z.array(z.object({ uri: z.string().nullish() })).nullish(),
});

// A copy of the listed fields. A null or a missing field stays out, so the
// PUT call uses its default.
function pick(source: JsonObject, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};

  for (const key of keys) {
    const value = source[key];

    if (value !== undefined && value !== null) out[key] = value;
  }

  return out;
}

function objects(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter((v) => isJsonObject(v)) : [];
}

// The policy has a rule for everyone and the decision is "bypass".
const isPublicBypass = (p: z.infer<typeof policySchema>): boolean =>
  p.decision === "bypass" &&
  (p.include ?? []).some((rule) => "everyone" in rule);

interface ParsedApp {
  fields: z.infer<typeof appSchema>;
  raw: JsonObject;
}

async function readApp(cf: Cloudflare, id: string): Promise<ParsedApp> {
  const raw = await cf.accessApp(id);
  const fields = appSchema.safeParse(raw);

  if (!fields.success || !isJsonObject(raw)) {
    throw new AccessSyncError(
      "Cloudflare returned an Access application that fullsend cannot read. Nothing changed.",
    );
  }

  return { fields: fields.data, raw };
}

// The PUT body from a GET. It keeps each writable field of the application.
// A policy goes back as an application-scoped policy in full. A reusable
// policy goes back as a link: { id, precedence }.
function updateBody(
  app: ParsedApp,
  domain: string,
  destinations: JsonObject[],
): AccessAppUpdate {
  const policies = objects(app.raw.policies).map((p, i) => {
    const info = app.fields.policies?.[i];

    if (info?.reusable === true) {
      return pick(p, ["id", "precedence"]);
    }

    return pick(p, POLICY_FIELDS);
  });

  return {
    ...pick(app.raw, APP_FIELDS),
    name: app.fields.name,
    type: "self_hosted",
    domain,
    destinations,
    policies,
  };
}

// The destinations that the application has now, and the wanted ones that
// it lacks. A destination that the owner added stays, so it does not go
// behind the login. A public destination is the same when the `uri` is
// the same.
function mergeDestinations(
  current: JsonObject[],
  wanted: JsonObject[],
): JsonObject[] {
  const uris = new Set(current.map((d) => d.uri));

  return [...current, ...wanted.filter((d) => !uris.has(d.uri))];
}

// Sets the destinations of an existing application to the current public
// paths. The PUT call replaces the whole application. So the sync reads
// the application, keeps every writable field, and adds the missing
// public paths to `destinations`. Then it reads the application again. If the check
// fails, it puts the first copy back. The sync writes `access_paths` only
// after a check that passes.
export async function syncApiApp(
  env: Env,
  cf: Cloudflare,
  app: AccessApp,
  hostname: string,
): Promise<void> {
  const before = await readApp(cf, app.id);

  // A public API without a bypass policy is not safe to change. Do not
  // write anything.
  if (!(before.fields.policies ?? []).some(isPublicBypass)) {
    throw new AccessSyncError(
      `The API application has no public bypass policy. Nothing changed. Fix the "${API_APP_NAME}" application in Cloudflare Zero Trust: it needs a policy with the action "Bypass" for "Everyone".`,
    );
  }

  const wanted = apiDestinations(hostname);

  const current = objects(before.raw.destinations).map((d) =>
    pick(d, DESTINATION_FIELDS),
  );

  const original = updateBody(before, before.fields.domain, current);

  const next = updateBody(
    before,
    `${hostname}${PUBLIC_PATHS[0]}`,
    mergeDestinations(current, wanted),
  );

  let problem: string | null = null;

  try {
    await cf.updateAccessApp(app.id, next);
    const after = await readApp(cf, app.id);
    const uris = new Set((after.fields.destinations ?? []).map((d) => d.uri));

    if (!wanted.every((d) => uris.has(d.uri)))
      problem =
        "A public path is missing from the application after the update.";
    else if (!(after.fields.policies ?? []).some(isPublicBypass))
      problem = "The public bypass policy is missing after the update.";
  } catch (err) {
    problem = err instanceof Error ? err.message : "Unknown error.";
  }

  if (problem === null) {
    await rememberPaths(env);

    return;
  }

  try {
    await cf.updateAccessApp(app.id, original);
  } catch (err) {
    const detail = err instanceof CloudflareError ? err.message : "error";

    throw new AccessSyncError(
      `The path sync failed (${problem}) and fullsend could not undo it (${detail}). Check the "${API_APP_NAME}" application in Cloudflare Zero Trust now.`,
    );
  }

  throw new AccessSyncError(
    `The path sync failed (${problem}). The sync was undone.`,
  );
}
