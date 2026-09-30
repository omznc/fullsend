<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-dark.svg">
    <img src="logo-light.svg" alt="fullsend" height="48">
  </picture>
</h1>

fullsend is an email API runs completely on Cloudflare. Supports the `resend` SDK for sending, so it's more or less a drop in replacement..

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/omznc/fullsend)

## Deploy

1. Click the "Deploy to Cloudflare" button. The deploy makes the D1
   database, the R2 bucket and the three queues.
2. In the deploy form, set these values:
   - `SETUP_TOKEN`: a long random string. It opens the first setup.
   - `SESSION_SECRET`: the output of `openssl rand -hex 32`.
   - `CF_API_TOKEN` and `CF_ACCOUNT_ID`: an API token and its account.
     Permissions: Email Sending Edit, Zone Read, Queues Edit, Access: Apps
     and Policies Edit, Workers Scripts Edit.
   - Keep "Protect with Cloudflare Access" off. fullsend makes its own
     Access applications in step 4, and the API paths must stay public.
3. Open the Worker URL. Enter the setup token.
4. Choose the dashboard login. For an account without Zero Trust, click
   "use a password instead", set a password and go to step 6. For Access,
   give the API hostname (for example `email.example.com`) and the owner's
   email. fullsend attaches the hostname and makes two Cloudflare Access
   applications:
   - "fullsend dashboard" protects the dashboard.
   - "fullsend API" keeps `/emails`, `/domains`, `/api-keys`, `/webhooks`,
     `/t` and `/health` public. These paths use API keys.
5. Sign in through Access.
6. The setup wizard onboards a sending domain, makes its event
   subscription, makes the first API key and sends a test email.

If you rename a queue or the Worker in the deploy form, set
`EVENTS_QUEUE_NAME` or `WORKER_NAME` to the new name.

### Deploy by hand

The `deploy` script applies the D1 migrations before it deploys. On a new
account, make the database first:

```sh
pnpm install
pnpm build                          # the dashboard, into ui/dist
pnpm exec wrangler d1 create fullsend
pnpm run deploy
```

Then set the secrets from step 2 with `pnpm exec wrangler secret put`, and
continue at step 3.

## Send

Use the official `resend` SDK:

```ts
import { Resend } from "resend";

const resend = new Resend("fs_...", { baseUrl: "https://email.example.com" });

await resend.emails.send({
  from: "Acme <hello@email.example.com>",
  to: ["omar@example.net"],
  subject: "Hello",
  html: "<p>Hello</p>",
});
```

You can also set the `RESEND_BASE_URL` environment variable.

With curl:

```sh
curl https://email.example.com/emails \
  -H "Authorization: Bearer fs_..." \
  -H "Content-Type: application/json" \
  -d '{"from":"hello@email.example.com","to":"omar@example.net","subject":"Hello","text":"Hello"}'
```

## Service binding (RPC)

A Worker in the same account can call fullsend with no HTTP and no API key.
Copy [`rpc.d.ts`](rpc.d.ts) into the caller.

```jsonc
// wrangler.jsonc of the caller
"services": [
  { "binding": "FULLSEND", "service": "fullsend", "entrypoint": "FullsendRpc", "props": { "caller": "my-worker" } }
]
```

```ts
const { data, error } = await env.FULLSEND.sendEmail({
  from,
  to,
  subject,
  html,
});
```

The methods are `sendEmail`, `sendBatch`, `getEmail`, `listEmails`,
`updateEmail` and `cancelEmail`. They take the Resend request bodies (the
API names or the SDK names) and return `{ data, error }`. fullsend stores
each RPC email with the API key column `rpc:<caller>`.

## API

| Method | Path                                  |
| ------ | ------------------------------------- |
| POST   | `/emails`                             |
| POST   | `/emails/batch`                       |
| GET    | `/emails`, `/emails/:id`              |
| PATCH  | `/emails/:id`                         |
| POST   | `/emails/:id/cancel`                  |
| POST   | `/domains`, `/domains/:id/verify`     |
| GET    | `/domains`, `/domains/:id`            |
| PATCH  | `/domains/:id`                        |
| DELETE | `/domains/:id`                        |
| POST   | `/api-keys`                           |
| GET    | `/api-keys`                           |
| DELETE | `/api-keys/:id`                       |
| *      | `/webhooks`, `/webhooks/:id`          |
| POST   | `/webhooks/:id/signing-secret/rotate` |

The request bodies, the responses and the error names are the same as in
Resend. `Idempotency-Key` and `x-batch-validation` work as in Resend.

Webhooks use the Resend body and Svix signatures. `resend.webhooks.verify()`
and the `svix` package check them.

### Differences from Resend

- The size of an email, with its attachments, is 5 MiB or less. This is
  the Cloudflare limit.
- Cloudflare sends only the first `reply_to` address.
- fullsend has no templates, audiences, contacts, broadcasts or receiving.
- Open and click tracking are on by default for a new domain.
- Domains must be in a Cloudflare zone of the same account.
- The rate limit per key has steps of 10 requests per second.

## Develop

Requirements: Node 24 and pnpm.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # set AUTH_MODE=dev for a local dashboard
pnpm build                       # the UI, into ui/dist
pnpm dev                         # the Worker, on port 8787
pnpm dev:ui                      # the UI with hot reload, on port 5173
```

Checks:

```sh
pnpm lint:ci
pnpm typecheck
pnpm test
```

The tests run in the Workers runtime. One suite runs the official `resend`
SDK against the Worker.

To make an API key without the dashboard:

```sh
cd worker
node scripts/create-key.ts "my app" > key.sql
cf d1 execute fullsend --remote --file key.sql
```

## Layout

```
wrangler.jsonc   the Worker config and every binding
worker/src/      the Worker
  api/           the Resend-compatible routes
  dashboard/     /api/* for the UI
  send/          validation, idempotency, the send queue consumer
  events/        Cloudflare events to email status and webhooks
  webhooks/      webhook delivery and signing
  tracking/      the open pixel and the click redirect
  domains/       domains through the Cloudflare API
  db/            the Drizzle schema
worker/migrations/  D1 migrations
ui/              the dashboard
rpc.d.ts         the RPC types for callers
```

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

## Thanks

This was inspired by [Emailflare](https://github.com/0xdps/emailflare), but it's not a fork.
