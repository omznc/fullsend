# Changelog

Each section lists the changes of one release. A deploy shows its version
in Settings and in `GET /health`.

## 0.2.0

### Reliability

- Sweep the emails that stay in the send queue. The cron job now handles
  each email that is pending for 30 minutes or more.
- Keep the claim when the write of the message ID fails. The consumer
  tries the write 4 times, then it writes an `error` system event.
- Record a failed event when the put on the queue fails.
- Widen the pending window of an idempotency key.
- Store dead queue messages in the system events.
- Delete the R2 bodies together with the old rows in the retention job.
- Search for the text as it is. The characters `%` and `_`, and a long
  term, work in a search.
- Cut the table scans in the overview query. The overview returns
  `has_emails` in place of `total_emails`.
- Order the webhook attempts by the attempt number.

### Resend parity

- Send the headers `retry-after` and `ratelimit-*` with a 429 response.
- Answer 405 with an `Allow` header for a wrong method on a public path.
- Add the six error names that the Resend SDK has and fullsend did not.
- Change the name of an unexpected 500 error from `application_error` to
  `internal_server_error`. The RPC entrypoint keeps `application_error`.
- Page the lists of domains, API keys and webhooks with `limit`, `after`
  and `before`.
- Refuse the domain fields that fullsend ignores (`region`, `tls`,
  `custom_return_path` and `tracking_subdomain`) with a 422.
- Accept all 23 webhook event types of the SDK.
- Send `domain.updated` when the status of a domain changes.

### New endpoints

- `/suppressions`: add, list, get, remove, and batch add and remove. fullsend
  sends `suppression.added` and `suppression.removed`.
- `PATCH /api-keys/:id` renames an API key.
- `GET /emails/:id/attachments` and `GET /emails/:id/attachments/:id`,
  with a signed download link that expires after one hour.
- `GET /webhooks/:id/events`, the event, its attempts, and
  `POST /webhooks/:id/events/:id/replay`.
- `GET /emails/metrics`.
- `GET /logs` and `GET /logs/:id` read the request log, with the shape of
  the Resend SDK. fullsend stores no body and no `user_agent`, so these
  fields are `null`. The response body of an error is the Resend error
  body. Only a full access key can read them.
- `GET /health` returns the `version` field.

### Request log

- Write one `api_requests` row for each request to a Resend API route.
  The row has the method, the path, the status, the API key, the time
  taken, and the error name and message. It has no body, header or key.
- Keep the rows for 14 days.
- Add the `request_log` setting (on by default) and a toggle in Settings.
- Add the Logs screen and `GET /api/logs`. The filters are the status, the
  method, the API key and a path search.

### Dashboard API

- Add the system events API, `GET /api/system-events`.
- Add `POST /api/settings/access/sync-paths`. It updates the public paths
  of the "fullsend API" Access application in a deploy that has Access.
  An Access deploy must run it (or press the button in Settings) after
  the update. Without it, `/suppressions` and `/logs` show the Access
  login page. A manual Access setup has no button and the route returns 404. In that case, add the `/suppressions` and `/logs` destinations
  (each path and its `/*` subpath) to the Access bypass application by
  hand. Do the same for each public path of `PUBLIC_PATHS` that a later
  version adds.
- `GET /api/settings` returns `version` and `access.paths_current`.
- Settings shows the version.
- Add ignored emails. The owner can ignore a bounced, failed or complained
  email in the email detail page. An ignored email does not count in the
  overview, in the recent failures or in `GET /emails/metrics`. Use
  `POST /api/emails/:id/ignore`, `DELETE /api/emails/:id/ignore` and
  `POST /api/emails/ignore`. This needs migration `0003_ignored_emails`.

### Documentation

- Add the new endpoints, the differences from Resend and the Access path
  sync to the README.
- Add `openapi.json` (OpenAPI 3.1) for each public route. The Worker does
  not serve it. A test fails when a public route and the file differ.
- Add the Webhooks section: the event types, the signature headers and the
  retry schedule.
- Change the "Update a deploy" commands. They keep a value of `OLD` that
  you set, they exclude `ci.yml`, and they write the version in the commit
  message.

### Development

- The setup wizard pauses the domain verify loop in a hidden tab.
- CI runs `wrangler deploy --dry-run` after the build.
- Add a Playwright smoke test for the dashboard (`pnpm test:e2e`). A
  separate `e2e` job in CI runs it. `pnpm test` does not.
- Fix a flaky pipeline test. It wrote a setting with raw SQL and read a
  stale settings cache.
- Add the Renovate configuration. Renovate does nothing until the owner
  installs the Renovate app.

## 0.1.0

The first release.

- A Resend-compatible email API in one Cloudflare Worker. The official
  `resend` SDK works with no patch.
- Send through the `send_email` binding, with a queue, retries and
  scheduled emails.
- Domains, API keys and webhooks with Svix signatures.
- Open and click tracking.
- The React dashboard, with sign-in through Cloudflare Access or a
  password.
- The `FullsendRpc` entrypoint for a service binding.
- A deploy through the Deploy to Cloudflare button.
