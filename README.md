<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo-dark.svg">
  <img src="logo-light.svg" alt="fullsend" height="56">
</picture>

**An email API that runs completely on Cloudflare.**

A drop-in replacement that can use the `resend` SDK, with [some limits](#differences-from-resend).

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/omznc/fullsend">
  <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare">
</a>

[Deploy](#deploy) · [Send](#send) · [RPC](#service-binding-rpc) · [API](#api) · [Develop](#develop)

</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/overview-dark.png">
  <img src="docs/overview-light.png" alt="The fullsend dashboard overview, with example data">
</picture>

---

## Deploy

1. **Click "Deploy to Cloudflare".**
   The deploy makes the D1 database, the R2 bucket and the three queues.

2. **Fill in the deploy form.**
   The form needs no values.

> [!IMPORTANT]
> Keep **"Protect with Cloudflare Access"** off. fullsend makes its own
> Access applications, and the API paths must stay public.

3. **Open the Worker URL.**
   The setup page shows the remaining steps.

> [!NOTE]
> If you rename a queue or the Worker in the deploy form, set
> `EVENTS_QUEUE_NAME` or `WORKER_NAME` to the new name.

<details>
<summary><strong>Deploy by hand</strong></summary>

<br>

The `deploy` script applies the D1 migrations before it deploys. On a new
account, make the database first:

```sh
pnpm install
pnpm build                          # the dashboard, into ui/dist
pnpm exec wrangler d1 create fullsend
pnpm run deploy
```

Then open the Worker URL.

fullsend makes its session secret and its setup code in D1. To set your own
values, set the `SESSION_SECRET` or `SETUP_TOKEN` secret with
`pnpm exec wrangler secret put`.

</details>

<details>
<summary><strong>Update a deploy</strong></summary>

<br>

The Deploy button makes a copy of this repo, not a fork, so GitHub cannot
sync it. Cloudflare also writes the D1 database ID into `wrangler.jsonc` of
the copy. Apply the new changes as a patch, then push. The push deploys the
Worker.

For the first update, set `OLD` to the commit of this repo that you
deployed. After that, the commands read it from the last update commit.

```sh
git clone git@github.com:<you>/fullsend.git && cd fullsend
git fetch https://github.com/omznc/fullsend.git main
OLD=$(git log -1 --format=%s | grep -o '[0-9a-f]\{7,\}$')
NEW=$(git rev-parse --short FETCH_HEAD)
git diff --binary "$OLD" "$NEW" | git apply --index
git commit -m "update to omznc/fullsend $NEW"
git push
```

"No valid patches in input" means that the copy is up to date.

</details>

---

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

> [!TIP]
> You can also set the `RESEND_BASE_URL` environment variable.

With curl:

```sh
curl https://email.example.com/emails \
  -H "Authorization: Bearer fs_..." \
  -H "Content-Type: application/json" \
  -d '{"from":"hello@email.example.com","to":"omar@example.net","subject":"Hello","text":"Hello"}'
```

---

## Service binding (RPC)

A Worker in the same account can call fullsend with no HTTP and no API key.
Copy [`rpc.d.ts`](rpc.d.ts) into the caller.

```jsonc
// wrangler.jsonc of the caller
"services": [
  {
    "binding": "FULLSEND",
    "service": "fullsend",
    "entrypoint": "FullsendRpc",
    "props": { "caller": "my-worker" }
  }
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

| Method       | Method        | Method        |
| ------------ | ------------- | ------------- |
| `sendEmail`  | `sendBatch`   | `getEmail`    |
| `listEmails` | `updateEmail` | `cancelEmail` |

The methods take the Resend request bodies (the API names or the SDK names)
and return `{ data, error }`. fullsend stores each RPC email with the API key
column `rpc:<caller>`.

---

## API

The request bodies, the responses and the error names are the same as in
Resend. `Idempotency-Key` and `x-batch-validation` work as in Resend.

**Emails**

| Method  | Path                                              |
| ------- | ------------------------------------------------- |
| `POST`  | `/emails`                                         |
| `POST`  | `/emails/batch`                                   |
| `GET`   | `/emails`, `/emails/:id`                          |
| `PATCH` | `/emails/:id`                                     |
| `POST`  | `/emails/:id/cancel`                              |
| `GET`   | `/emails/:id/attachments`                         |
| `GET`   | `/emails/:id/attachments/:attachment_id`          |
| `GET`   | `/emails/:id/attachments/:attachment_id/download` |
| `GET`   | `/emails/metrics`                                 |

The attachment routes return a `download_url`. The URL is signed and
expires after one hour. It needs no API key. It returns 404 after the
retention period deleted the body of the email.

`/emails/metrics` counts the email events in D1. It supports the `period`,
`domain` and `email` dimensions, the `domain_id` and `email_id` filters and
all four granularities, in UTC. Each rate is a fraction from 0 to 1.

**Domains**

| Method   | Path                              |
| -------- | --------------------------------- |
| `POST`   | `/domains`, `/domains/:id/verify` |
| `GET`    | `/domains`, `/domains/:id`        |
| `PATCH`  | `/domains/:id`                    |
| `DELETE` | `/domains/:id`                    |

**API keys**

| Method   | Path            |
| -------- | --------------- |
| `POST`   | `/api-keys`     |
| `GET`    | `/api-keys`     |
| `PATCH`  | `/api-keys/:id` |
| `DELETE` | `/api-keys/:id` |

**Webhooks**

| Method | Path                                               |
| ------ | -------------------------------------------------- |
| `*`    | `/webhooks`, `/webhooks/:id`                       |
| `POST` | `/webhooks/:id/signing-secret/rotate`              |
| `GET`  | `/webhooks/:id/events`, `/webhooks/:id/events/:id` |
| `GET`  | `/webhooks/:id/events/:id/attempts`                |
| `POST` | `/webhooks/:id/events/:id/replay`                  |

Webhooks use the Resend body and Svix signatures. `resend.webhooks.verify()`
and the `svix` package check them. A webhook accepts each event type of the
Resend SDK. fullsend sends the `email.*` events (except `email.received`),
`suppression.added`, `suppression.removed` and `domain.updated`.

**Suppressions**

| Method   | Path                                 |
| -------- | ------------------------------------ |
| `POST`   | `/suppressions`                      |
| `GET`    | `/suppressions`, `/suppressions/:id` |
| `DELETE` | `/suppressions/:id`                  |
| `POST`   | `/suppressions/batch/add`            |
| `POST`   | `/suppressions/batch/remove`         |

In a `:id` position, a suppression route accepts an id or an email address.

**Lists**

`GET /emails`, `/domains`, `/api-keys`, `/webhooks`, `/suppressions` and the
event and attachment lists use the Resend cursor pages (`limit`, `after`,
`before`).

### Differences from Resend

| Area               | fullsend                                                                          |
| ------------------ | --------------------------------------------------------------------------------- |
| Email size         | 5 MiB or less, with attachments. This is the Cloudflare limit.                    |
| `path` attachments | 10 or fewer in one email. fullsend fetches them one by one.                       |
| `reply_to`         | Cloudflare sends only the first address.                                          |
| Missing features   | No templates, audiences, contacts, broadcasts or receiving.                       |
| Missing endpoints  | No `/logs` and no `POST /emails/:id/share`.                                       |
| Domain `region`    | Only `global`. Any other value gives a 422.                                       |
| Domain `tls`       | Only `opportunistic`. `enforced` gives a 422.                                     |
| Domain fields      | `custom_return_path` must be `send`. `tracking_subdomain` gives a 422.            |
| Tracking           | Open and click tracking are on by default for a new domain.                       |
| Domains            | Must be in a Cloudflare zone of the same account.                                 |
| Rate limit         | The limit per key has steps of 10 requests per second.                            |
| Suppression ids    | An id is `sup_` and the base64url address, not a UUID.                            |
| Suppression batch  | 100 addresses or fewer in one request.                                            |
| Metrics            | UTC only. No `received`, `unsubscribed` or broadcast data.                        |
| Webhook events     | Each type is accepted. fullsend does not send contact, topic or receiving events. |
| Event attempts     | An attempt with no response has `http_status_code` 0.                             |

> [!NOTE]
> A deploy that has Cloudflare Access must add each new public path to the
> "fullsend API" Access application. After an update, send
> `POST /api/settings/access/sync-paths` from the dashboard session. The
> setup does the same when it reuses the application.

---

## Develop

**Requirements:** Node 24 and pnpm.

```sh
pnpm install
cp .dev.vars.example .dev.vars   # set AUTH_MODE=dev for a local dashboard
pnpm build                       # the UI, into ui/dist
pnpm dev                         # the Worker, on port 8787
pnpm dev:ui                      # the UI with hot reload, on port 5173
```

**Checks:**

```sh
pnpm lint:ci
pnpm typecheck
pnpm test
```

The tests run in the Workers runtime. One suite runs the official `resend`
SDK against the Worker.

**Make an API key without the dashboard:**

```sh
cd worker
node scripts/create-key.ts "my app" > key.sql
cf d1 execute fullsend --remote --file key.sql
```

### Layout

```
wrangler.jsonc        the Worker config and every binding
worker/
├── src/              the Worker
│   ├── api/          the Resend-compatible routes
│   ├── dashboard/    /api/* for the UI
│   ├── send/         validation, idempotency, the send queue consumer
│   ├── events/       Cloudflare events to email status and webhooks
│   ├── webhooks/     webhook delivery and signing
│   ├── tracking/     the open pixel and the click redirect
│   ├── domains/      domains through the Cloudflare API
│   └── db/           the Drizzle schema
└── migrations/       D1 migrations
ui/                   the dashboard
rpc.d.ts              the RPC types for callers
```

---

## License

[AGPL-3.0-only](LICENSE).

## Thanks

This was inspired by [Emailflare](https://github.com/0xdps/emailflare), but it's not a fork.
