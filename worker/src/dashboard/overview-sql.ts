// The SQL of the overview stats. An ignored email does not count. The
// partial index `emails_ignored` holds only the ignored emails, so the
// subquery does not scan the emails table.

const IGNORED = `email_id NOT IN (SELECT id FROM emails WHERE ignored_at IS NOT NULL)`;

// The count of emails for each event type in a time range. Binds: from, to.
export const COUNTS_SQL = `SELECT type, COUNT(DISTINCT email_id) AS n FROM email_events
  WHERE created_at >= ? AND created_at < ? AND bot IS NULL
    AND type IN ('sent','delivered','bounced','complained','opened','clicked')
    AND ${IGNORED}
  GROUP BY type`;

// The count of emails for each bucket and event type for the chart.
// Binds: bucket size, since. D1 binds a number as a real. The CAST keeps
// the division as an integer division, so the bucket starts match.
export const SERIES_SQL = `SELECT (created_at / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS bucket, type, COUNT(DISTINCT email_id) AS n FROM email_events
  WHERE created_at >= ?2 AND bot IS NULL AND type IN ('sent','delivered','bounced')
    AND ${IGNORED}
  GROUP BY bucket, type ORDER BY bucket`;
