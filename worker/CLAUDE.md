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
- `src/cron.ts`: one cron each minute. It sends due scheduled emails each
  minute, syncs the domains each 15 minutes, and runs retention at 03:00
  UTC.
- `scripts/create-key.ts`: makes an API key and its SQL without the
  dashboard. Run it with `node`.

## Rules

- **Two error shapes.** A public route throws `ApiError`
  (`src/lib/errors.ts`), and `app.onError` returns the Resend body
  `{ statusCode, name, message }`. A dashboard route returns
  `c.json({ error, message }, status)`. Use the Resend error names from
  `ErrorName` on the public side.
- **A permanent send failure is never a 5xx.** The send consumer
  (`src/send/consumer.ts`) marks a code in `PERMANENT` as `failed` and acks
  it. Other errors retry with backoff up to `MAX_ATTEMPTS` (5). Keep
  `MAX_ATTEMPTS` below `max_retries` of `fullsend-send` in `wrangler.jsonc`,
  so the queue never drops a message.
- **The queue handler routes by the message body, not by the queue name.**
  The deploy form can rename the queues. A body with `emailId` goes to the
  send consumer. A body with `webhookId` goes to webhook delivery.
  Everything else goes to the events consumer. A new message type needs a
  field that the other checks do not match.
- **Do not hard-code the Worker name or the events queue name.** Use
  `env.WORKER_NAME` and `env.EVENTS_QUEUE_NAME`. The deploy form can change
  them.
- **`PUBLIC_PATHS` in `src/dashboard/setup.ts` must match the public
  routes.** The setup writes these paths into the "fullsend API" Access
  application. The setup reuses an application that already has that name
  and does not update its paths. So a new public path does not reach a
  deploy that already has Access. Also add a new public path to the proxy
  list in `ui/vite.config.ts`.
- **The dashboard fails closed.** When Access is set up, the catch-all in
  `src/index.ts` serves no UI to a request without a valid Access JWT. This
  also covers the `workers.dev` URL. Do not add a route that serves UI
  before that check.
- **The tracking hostname serves only `/t/*`.** The first middleware in
  `src/index.ts` returns 404 for other paths on it.
- **The `api_key_id` column is not always a key id.** It can hold
  `rpc:<caller>` or `dashboard:<identity>` (`src/db/schema.ts`).
- **`SESSION_SECRET` signs the dashboard sessions and the click links.** A
  setup token can fall back to `SETUP_TOKEN` as its key. A session token
  cannot (`signingKey` in `src/dashboard/auth.ts`).
- **Settings are rows in the `settings` table** (`src/lib/settings.ts`).
  `getSettingsCached` can be 30 seconds old in one isolate. Add a new key to
  `DEFAULTS`: `getSettings` ignores a key that is not there.
- **Store times as epoch milliseconds.** The API shows them as ISO 8601.

## Env and bindings

`src/env.ts` is the hand-written `Env`. There is no generated
`worker-configuration.d.ts`. A new binding goes in the root
`wrangler.jsonc` and in `src/env.ts`. A new secret also goes in
`.dev.vars.example` and in `cloudflare.bindings` of the root `package.json`.

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
  there. `test/dashboard.test.ts` uses `AUTH_MODE: "password"` in its env,
  the setup token flow, or Access settings that it inserts into D1.
