// The latest failed emails. SQLite does not read an index in order across
// the values of an IN list: it picks another index and sorts. So each
// status gets its own query, and each one reads emails_status_event
// (status, last_event_at) in order and stops at 10 rows. An ignored
// email is skipped.
const FAILED_STATUSES = ["failed", "bounced", "complained"];

export const FAILURES_SQL = `SELECT id, "to", subject, status, error, last_event_at FROM (
${FAILED_STATUSES.map(
  (status) => `  SELECT * FROM (
    SELECT id, "to", subject, status, error, last_event_at FROM emails
    WHERE status = '${status}' AND ignored_at IS NULL ORDER BY last_event_at DESC LIMIT 10
  )`,
).join("\n  UNION ALL\n")}
) ORDER BY last_event_at DESC LIMIT 10`;
