# worker

`@fullsend/worker`: the one Cloudflare Worker. Hono for routes, zod for
input, Drizzle on D1, `jose` for the Access JWT. Its config is the root
`wrangler.jsonc` (`main` is `worker/src/index.ts`). Read the root `CLAUDE.md`
first.

## Layout

- `src/index.ts` is the entry. `fetch` is the Hono app. It also exports
  `queue`, `scheduled` and `FullsendRpc` (`src/rpc.ts`).
- `src/api/`: the Resend-compatible routes, one file per resource.
  `src/api/auth.ts` checks the API key and the rate limit.
- `src/dashboard/`: the dashboard API under `/api`. `setup.ts` holds the
  routes that work before sign-in (`/session`, `/setup/*`, `/auth/*`). The
  other files are behind `requireIdentity`.
- `src/send/`: validation, idempotency, create, manage, and the send queue
  consumer. `src/events/`: the Email Sending events. `src/webhooks/`:
  delivery and Svix signatures. `src/tracking/`: the open pixel and the
  click redirect. `src/domains/`: domains through the Cloudflare API
  (`src/lib/cloudflare.ts`).
- `src/cron.ts`: one cron each minute. It sends due scheduled emails and
  sweeps stuck emails each minute, syncs the domains each 15 minutes, and
  runs retention at minute 7 of each hour. Retention works in chunks of 500
  rows with a time budget, so a run can stop and the next hour finishes it.
  The request log (`api_requests`) has a larger chunk of 5,000 rows, because
  it grows with the traffic. One run clears 100,000 rows of it at most.
  It deletes the R2 bodies before the rows. A failure of a job goes to
  `system_events` through `logSystemEvent` (`src/lib/system-events.ts`).
- `scripts/create-key.ts`: makes an API key and its SQL without the
  dashboard. Run it with `node`.

## Rules

- **Two error shapes.** A public route throws `ApiError`
  (`src/lib/errors.ts`), and `app.onError` returns the Resend body
  `{ statusCode, name, message }`. A dashboard route returns
  `c.json({ error, message }, status)`. A dashboard route can also throw an
  `ApiError`: `dashboardApi.onError` in `src/dashboard/index.ts` shows it as
  `{ error, message }`. Use the Resend error names from `ErrorName` on the
  public side.
- **A permanent send failure is never a 5xx.** The send consumer
  (`src/send/consumer.ts`) marks a code in `PERMANENT` as `failed` and acks
  it. Other errors retry with backoff up to `MAX_ATTEMPTS` (5). Keep
  `MAX_ATTEMPTS` below `max_retries` of `fullsend-send` in `wrangler.jsonc`,
  so the queue never drops a message.
- **The cron sweep never puts a claimed email back on the queue.**
  `sweepStuck` in `src/cron.ts` runs each minute. It handles a pending
  email that is older than `STUCK_AFTER` (30 minutes). With a
  `cf_message_id` it records the sent event. With no claim it puts the
  email on the queue again, 3 times at most, then it fails the email. With
  an old claim it fails the email and never sends it again: the consumer
  can stop during `EMAIL.send`.
- **The send claim has a token and a send mark.** The consumer
  (`src/send/consumer.ts`) takes the email with `claimed_at` and a new
  `claim_token`. Before `EMAIL.send` it writes `send_started_at` for its own
  token. A later copy of the message takes an expired claim only when
  `send_started_at` is not set. A marked and unfinished email stays for the
  sweep, which fails it with "can be sent already". `release` and `giveUp`
  end only the claim with their own token, so a consumer never clears the
  claim of a different consumer. `release` also clears the mark, because
  the send failed. One window stays: if the Worker stops after `send`
  returns and before `cf_message_id` is stored, the sweep fails the email
  and no copy sends it again. Keep the code between `send` and the store
  short. A D1 error on that store is not part of this window. The consumer
  tries the store again 3 times. If each try fails, it keeps the claim,
  acks the message and writes an `error` system event with the email id and
  the Cloudflare message id. Case c of the sweep then fails the email with
  "can be sent already". The consumer never releases the claim after `send`
  returned.
- **The queue handler routes by the message body, not by the queue name.**
  The deploy form can rename the queues. A body with `emailId` goes to the
  send consumer. A body with `webhookId` goes to webhook delivery.
  Everything else goes to the events consumer. A new message type needs a
  field that the other checks do not match.
- **Do not hard-code the Worker name or the events queue name.** Use
  `env.WORKER_NAME` and `env.EVENTS_QUEUE_NAME`. The deploy form can change
  them.
- **`PUBLIC_PATHS` in `src/public-paths.ts` is the one list of the public
  paths.** It must match the public routes. `src/index.ts`, the setup, the
  `GET /api/settings` response and `ui/vite.config.ts` import or read it.
  Do not copy the list. The setup writes these paths into the "fullsend
  API" Access application. The setup reuses an application that already
  has that name and updates its paths. A deploy that already has Access
  gets a new public path after `POST /api/settings/access/sync-paths`
  (`src/dashboard/access-paths.ts`). The file has no imports, so
  keep it that way.
- **The dashboard fails closed.** When Access is set up, the catch-all in
  `src/index.ts` serves no UI to a request without a valid Access JWT. This
  also covers the `workers.dev` URL. Do not add a route that serves UI
  before that check.
- **The tracking hostname serves only `/t/*`.** The first middleware in
  `src/index.ts` returns 404 for other paths on it.
- **The `api_key_id` column is not always a key id.** It can hold
  `rpc:<caller>` or `dashboard:<identity>` (`src/db/schema.ts`).
- **The first setup chooses the dashboard login.** The `auth_mode` and
  `password_hash` settings hold the choice, not env vars. The setup code
  or a pasted Cloudflare token opens the setup only while `setupOpen()` in `src/dashboard/auth.ts` is
  true: no Access and no password yet. `AUTH_MODE` in env is only for
  `dev`. A session key also holds the password hash, so a new password
  ends the old sessions.
- **The session secret signs the dashboard sessions, the setup cookie and
  the click links.** `sessionSecret()` in `src/lib/secrets.ts` returns
  `SESSION_SECRET`, or a value that it makes one time and keeps in D1.
  `setupCode()` does the same for `SETUP_TOKEN`. The Worker logs the code
  while the dashboard is locked. These D1 rows are not in `DEFAULTS`, so
  `getSettings` never returns them.
- **A pasted token must prove the ownership.** `POST /setup/token` in
  `src/dashboard/setup.ts` accepts the token only when its account serves
  the request host: `<WORKER_NAME>.<subdomain>.workers.dev`, or a custom
  domain of the Worker. Then it writes the Worker secrets. Cloudflare
  deploys a new version, so the secrets reach requests some seconds later.
- **Settings are rows in the `settings` table** (`src/lib/settings.ts`).
  `getSettingsCached` can be 30 seconds old in one isolate. Add a new key to
  `DEFAULTS`: `getSettings` ignores a key that is not there.
- **Store times as epoch milliseconds.** The API shows them as ISO 8601.

## Env and bindings

`src/env.ts` is the hand-written `Env`. There is no generated
`worker-configuration.d.ts`. A new binding goes in the root
`wrangler.jsonc` and in `src/env.ts`. A new optional secret also goes
as a comment in `.dev.vars.example`.

## Database

- The schema is `src/db/schema.ts`. To make a migration, run
  `pnpm --filter @fullsend/worker db:generate` (drizzle-kit). It writes into
  `worker/migrations/`, the `migrations_dir` of D1.
- A new migration must work with the Worker that is live now. The
  `deploy` script migrates first, then deploys.
- Some code uses raw SQL through `env.DB.prepare` (the cron, the
  settings). Check it when you rename a column.

## Tests

- `vitest run` with `@cloudflare/vitest-pool-workers`. The tests run in
  workerd with the root `wrangler.jsonc`. `test/setup.ts` applies every
  migration from `worker/migrations/` to a fresh D1.
- `test/helpers.ts`: `call()` sends a request to the Worker at
  `http://fullsend.test`. `routeFetchToWorker()` points the `resend` SDK at
  the Worker.
- The Cloudflare API has no live calls in tests. `test/cloudflare.test.ts`
  replaces `globalThis.fetch` with a fake that fails on an unknown route.
- The test host is not `localhost`, so `AUTH_MODE=dev` does not work
  there. `test/dashboard.test.ts` uses the setup code flow, or Access
  settings that it inserts into D1.
- D1 keeps its rows between the tests of one file. A test that needs a
  fresh setup deletes the `settings` rows first.
- Change a setting in a test with `setSettings`, not with raw SQL. The
  Worker caches the settings for 30 seconds in `getSettingsCached`. Raw SQL
  leaves the old value in the cache. Any request to the Worker fills the
  cache, also a request from outside the tests (see the next item).
- A process outside the repo can probe the local test ports. A tool on the
  machine of the developer (for example a port scanner of a desktop app)
  sends `HEAD /` to the miniflare ports. workerd then prints "Expected
  global Vitest state" when the probe comes outside a test. This is noise
  and not a test failure. To prove it, run the tests in a network
  namespace: `unshare -rn sh -c "ip link set lo up; pnpm test"`. The
  message does not appear there.
