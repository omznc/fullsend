# CLAUDE.md

This file is the always-loaded half. `worker/` and `ui/` each have a
`CLAUDE.md` that loads when you touch a file in them. See **Where the rest
lives** below.

fullsend is an email API that is compatible with Resend. It is one
Cloudflare Worker. The Worker serves the Resend API, the dashboard API
(`/api`), the tracking links (`/t`), the React dashboard (static assets from
`ui/dist`) and the RPC entrypoint `FullsendRpc`. It sends through the
`send_email` binding. The official `resend` SDK must work against it with no
patch. License: AGPL-3.0-only.

## pnpm and Node, not Bun

This repo uses **pnpm workspaces** (`pnpm@11.24.0`, workspaces `worker` and
`ui`) and Node 24. The parent `~/dev/CLAUDE.md` tells agents to use Bun. That
instruction does not apply here. Do not run `bun install`, `bun test` or
`bun <file>`. Run a worker script with `node` (Node 24 runs `.ts` files).

- `pnpm-workspace.yaml` has `allowBuilds` (esbuild, workerd) and a
  `minimumReleaseAgeExclude` list of exact versions. If `pnpm install`
  refuses a version because it is too new, add the exact version to that
  list.
- `pnpm deploy` is a pnpm built-in command, not the `deploy` script. Use
  `pnpm run deploy`. Do not deploy without approval from the user.

## Commands

Run from the repo root.

```bash
pnpm install
pnpm build            # the UI only (vite build into ui/dist)
pnpm dev              # the Worker (wrangler dev) on :8787, serves ui/dist
pnpm dev:ui           # the Vite dev server on :5173, proxies to :8787
pnpm typecheck        # pnpm -r typecheck (tsc --noEmit in each workspace)
pnpm test             # pnpm -r test (only worker has tests: vitest run)
pnpm lint             # oxlint --fix && oxfmt
pnpm lint:ci          # oxlint && oxfmt --check (what CI runs)
pnpm format           # oxfmt
pnpm run db:migrate   # applies worker/migrations to the REMOTE D1 database
```

To check your work, run `pnpm lint:ci`, `pnpm typecheck` and `pnpm build`.
Run `pnpm test` too when you change `worker/`. All four are at zero errors
now. Keep them there.

CI (`.github/workflows/ci.yml`) runs on a push to `main` and on each pull
request: `pnpm install --frozen-lockfile`, `pnpm lint:ci`, `pnpm build`,
`pnpm typecheck` and `pnpm test`, on Node 24. CI never deploys.

`pnpm dev` serves the UI from `ui/dist`. Run `pnpm build` first, or use
`pnpm dev:ui` for hot reload. Copy `.dev.vars.example` to `.dev.vars` and set
`AUTH_MODE=dev` for a local dashboard without a login. `dev` mode works only
on `localhost` and `127.0.0.1`.

## Cloudflare: `cf`, not `wrangler`

Use the `cf` CLI for Cloudflare tasks (`cf deploy`, `cf d1 execute`, and so
on). To find a command, run `cf cli search "<task>"`.

- `cf dev` does not work in this repo. At the root it stops with "run in the
  root of a workspace". In `worker/` it finds no wrangler config and stops
  with "Hono cannot be automatically configured". Use `pnpm dev` for local
  work.
- The root `deploy`, `db:migrate` and `dev` scripts call `wrangler` on
  purpose. The "Deploy to Cloudflare" button runs the `deploy` script, and
  the button uses Wrangler. Do not change these scripts to `cf`.
- `db:migrate` has `--remote`. It changes the deployed D1 database. Ask
  before you run it.
- Do not change a Cloudflare resource (Access applications, queues, D1,
  R2, custom domains, Email Sending) without approval from the user.
- When the auth profile has more than one account, `cf` stops with "More
  than one account available". Set `CLOUDFLARE_ACCOUNT_ID` for the
  command.

## Lint and format

`oxlint` lints (`oxlint.config.ts`) and `oxfmt` formats (`.oxfmtrc.jsonc`: 2
spaces, double quotes, width 80, trailing commas, sorted imports). oxfmt also
formats Markdown and JSON. `worker/migrations`, `pnpm-lock.yaml` and
`tools/oxlint/anti-slop` are in its ignore list.

- The categories `correctness` and `suspicious` are errors. There are no
  warnings.
- The plugins are `eslint`, `typescript`, `unicorn`, `oxc`, `react`,
  `import` and `promise`. The React rules are strict. `ui/CLAUDE.md` lists
  the ones that fail most often.
- `typescript/consistent-type-imports` and `typescript/no-explicit-any` are
  errors. Import a type with `import type` or an inline `type` specifier.
  `tsconfig.base.json` also sets `verbatimModuleSyntax`.
- `promise/always-return` is an error. Each `.then()` callback must return
  a value. An arrow with an expression body does that.
- `import/no-unassigned-import` is an error. Only `ui/src/main.tsx` may
  have an import with no binding (`./index.css` and `./lib/theme`).
- `typescript/no-non-null-assertion` is off. `tsconfig.base.json` sets
  `noUncheckedIndexedAccess`, so `arr[i]!` is the normal pattern.
- The vendored anti-slop plugin (`tools/oxlint/anti-slop`) adds rules
  against low-evidence code. All its generic rules are errors. Fix the
  cause of a finding. Do not disable a rule. `tools/oxlint/README.md` tells
  how to fix each kind of finding. The common ones:
  - A type assertion (`as X`) needs a `// SAFETY:` comment that states the
    invariant. Parse JSON with zod in the Worker where possible.
  - `typeof` is allowed only in a named type guard.
  - Do not use `Record<string, unknown>` or `unknown` in a signature. Give
    the value a real type, for example `JsonValue`.
  - Do not write `...(cond ? { x } : {})`. Set the key in a statement.
  - `require-readable-spacing` wants blank lines around blocks.
    `pnpm lint` adds them.
- Keep `oxlint` and `@oxlint/plugins` at the same exact version.
- To see the full rule list, run `pnpm exec oxlint --print-config`.

## Rules for the whole repo

- **The public API owns `/emails`, `/domains`, `/api-keys`, `/webhooks`,
  `/t` and `/health`.** Cloudflare Access bypasses these paths (the
  "fullsend API" application, `PUBLIC_PATHS` in
  `worker/src/dashboard/setup.ts`). Everything else on the API hostname is
  behind Access. A dashboard page must never use one of these paths. The
  dashboard pages live under `/dashboard`. See `ui/CLAUDE.md`.
- **Every non-GET request to `/api` needs the header
  `X-Fullsend-Dashboard: 1`.** This is the CSRF guard
  (`worker/src/dashboard/index.ts`). `ui/src/api.ts` adds it. A test that
  calls `/api` with POST, PATCH or DELETE must add it too.
- **The Resend contract comes first.** The public routes keep the Resend
  paths, bodies, responses and error names. `worker/test/resend-sdk.test.ts`
  runs the real `resend` SDK against the Worker.
- **`rpc.d.ts` at the root is a public contract.** Callers copy it. Change
  it together with `worker/src/rpc.ts`.
- **The deploy form makes each key in `.dev.vars.example` a required
  field.** The form has no optional secret, no dropdown and no conditional
  field. Keep the form empty: every key in `.dev.vars.example` is a
  comment. Put an optional setting in `vars` in `wrangler.jsonc` with a
  default. Put a choice of the owner in the first setup and store it in the
  D1 settings. The dashboard login (Access or a password) works this way.
- **fullsend makes its own secrets.** `worker/src/lib/secrets.ts` makes the
  session secret and the setup code and keeps them in D1. The first setup
  writes `CF_API_TOKEN` and `CF_ACCOUNT_ID` as Worker secrets from the
  token that the owner pastes (`POST /api/setup/token`). A new optional
  secret goes in `worker/src/env.ts` and as a comment in
  `.dev.vars.example`.

## Release

To make a release:

1. Set `version` in the root `package.json`. The test
   `worker/test/version.test.ts` keeps `VERSION` in `worker/src/version.ts`
   in step with it. Change both.
2. Add a section `## <version>` at the top of `CHANGELOG.md`.
3. Commit. The user tags the commit `v<version>`. Agents do not push tags.

## Gotchas

- The dashboard API returns errors as `{ error, message }`. The public API
  returns the Resend shape `{ statusCode, name, message }`. Do not mix them.
- `.github/workflows/ci.yml` is the only workflow.
- **A deploy from the button is a copy, not a fork.** Its repo has one
  commit ("source repo import") and no shared history with this repo.
  Cloudflare adds `database_id` and `preview_bucket_name` to
  `wrangler.jsonc` in the copy, and removes `.github/workflows/ci.yml`. An
  owner updates the copy with a patch (README "Update a deploy"), so a
  change to the D1 or R2 lines of `wrangler.jsonc` can make that patch
  fail. A push to the main branch of the copy deploys it.
- **A new Access app can refuse a valid login for some minutes.** Access
  shows "That account does not have access". Before you change the policy
  code, read the Access logs
  (`cf zero-trust access logs access-requests list`) and the policy tester.

## Where the rest lives

These files are not loaded for you. Read the one for the area before you
change it.

| Read this                          | Before you touch                                                      |
| ---------------------------------- | --------------------------------------------------------------------- |
| `README.md`                        | the deploy steps, the API table, the differences from Resend, the RPC |
| `tools/oxlint/README.md`           | the anti-slop plugin, and how to fix each kind of finding             |
| `rpc.d.ts`                         | the RPC types that callers copy                                       |
| `worker/CLAUDE.md`, `ui/CLAUDE.md` | load on their own when you touch a file there                         |
