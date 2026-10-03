import type { Env } from "../env";
import { emitEvent, type Hook } from "../events/record";
import { normalize, parseAddress } from "../lib/address";
import { fromBase64, toBase64Url } from "../lib/crypto";
import { ApiError, notFound, validation } from "../lib/errors";
import { isString, type JsonObject, type JsonValue } from "../lib/json";
import { type Page, pageQuery } from "../lib/page";
import { iso } from "../lib/time";

export type SuppressionReason = "hard_bounce" | "complaint" | "manual";

export interface SuppressionRow {
  address: string;
  reason: SuppressionReason;
  source: string;
  email_id: string | null;
  created_at: number;
}

// The Resend names of the origin of a suppression.
export type SuppressionOrigin = "bounce" | "complaint" | "manual";

const ORIGIN: Record<SuppressionReason, SuppressionOrigin> = {
  hard_bounce: "bounce",
  complaint: "complaint",
  manual: "manual",
};

// The most addresses in one batch request.
export const MAX_BATCH = 100;

const ID_PREFIX = "sup_";

// The suppressions table has no id column, and a new migration is not
// needed for one. The id holds the address, so a lookup by id needs no
// read of the table.
export const suppressionId = (address: string): string =>
  ID_PREFIX + toBase64Url(new TextEncoder().encode(address));

// The address in an id, or null when the text is not an id of fullsend.
function addressOfId(id: string): string | null {
  if (!id.startsWith(ID_PREFIX)) return null;

  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      fromBase64(
        id.slice(ID_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/"),
      ),
    );
  } catch {
    return null;
  }
}

// Reads an `id` or an email address of a route. Returns the address in
// lower case, or null when the text is neither.
export function addressOf(idOrEmail: string): string | null {
  const fromId = addressOfId(idOrEmail);

  if (fromId !== null) return fromId;

  return parseAddress(idOrEmail) ? normalize(idOrEmail) : null;
}

export function originToReason(origin: string): SuppressionReason | null {
  for (const [reason, name] of Object.entries(ORIGIN)) {
    if (name === origin && isReason(reason)) return reason;
  }

  return null;
}

function isReason(value: string): value is SuppressionReason {
  return value in ORIGIN;
}

// The Resend shape of a suppression, without the `object` field.
export function suppressionJson(row: SuppressionRow) {
  return {
    id: suppressionId(row.address),
    email: row.address,
    origin: ORIGIN[row.reason],
    source_id: row.email_id,
    created_at: iso(row.created_at),
  };
}

// The `data` of a suppression.added or suppression.removed event.
function eventData(row: SuppressionRow): JsonObject {
  return suppressionJson(row);
}

export interface NewSuppression {
  address: string;
  reason: SuppressionReason;
  // Who or what added the address, for example "api" or "dashboard:omar".
  source: string;
  emailId?: string | null;
}

const insertSql = `INSERT INTO suppressions (address, reason, source, email_id, created_at)
  VALUES (?, ?, ?, ?, ?) ON CONFLICT (address) DO NOTHING RETURNING *`;

// Adds addresses and sends a suppression.added event for each new one.
// An address that is on the list is not changed. Returns the rows that
// the call added. D1 gets a batch for each 50 addresses, so no statement
// list is too long.
export async function addSuppressions(
  env: Env,
  items: NewSuppression[],
  hooks?: Hook[],
): Promise<SuppressionRow[]> {
  const now = Date.now();
  const added: SuppressionRow[] = [];

  for (let i = 0; i < items.length; i += 50) {
    const results = await env.DB.batch<SuppressionRow>(
      items
        .slice(i, i + 50)
        .map((s) =>
          env.DB.prepare(insertSql).bind(
            s.address,
            s.reason,
            s.source,
            s.emailId ?? null,
            now,
          ),
        ),
    );

    for (const r of results) added.push(...r.results);
  }

  for (const row of added) {
    await emitEvent(env, "suppression.added", eventData(row), hooks);
  }

  return added;
}

// Deletes addresses and sends a suppression.removed event for each one
// that was on the list. Returns the rows that the call deleted.
export async function removeSuppressions(
  env: Env,
  addresses: string[],
): Promise<SuppressionRow[]> {
  const removed: SuppressionRow[] = [];

  for (let i = 0; i < addresses.length; i += 50) {
    const results = await env.DB.batch<SuppressionRow>(
      addresses
        .slice(i, i + 50)
        .map((a) =>
          env.DB.prepare(
            "DELETE FROM suppressions WHERE address = ? RETURNING *",
          ).bind(a),
        ),
    );

    for (const r of results) removed.push(...r.results);
  }

  for (const row of removed) {
    await emitEvent(env, "suppression.removed", eventData(row));
  }

  return removed;
}

export async function getSuppression(
  env: Env,
  idOrEmail: string,
): Promise<SuppressionRow> {
  const address = addressOf(idOrEmail);

  const row = address
    ? await env.DB.prepare("SELECT * FROM suppressions WHERE address = ?")
        .bind(address)
        .first<SuppressionRow>()
    : null;

  if (!row) throw notFound("Suppression");

  return row;
}

// Checks one email address of a request body.
export function checkEmail(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    throw new ApiError(422, "missing_required_field", "Missing `email` field.");
  }

  if (!isString(value) || !parseAddress(value)) {
    throw validation("The `email` must be an email address.");
  }

  return normalize(value);
}

// Checks the `emails` list of a batch request.
export function checkEmails(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value) || !value.length) {
    throw new ApiError(
      422,
      "missing_required_field",
      "Missing `emails` field. Give a list of email addresses.",
    );
  }

  if (value.length > MAX_BATCH) {
    throw validation(`A batch can have ${MAX_BATCH} or fewer addresses.`);
  }

  return [...new Set(value.map(checkEmail))];
}

// Checks the `ids` list of a batch remove request. An entry that is not
// an id of fullsend has a null address, so the route reports it as not
// deleted.
export function checkIds(
  value: JsonValue | undefined,
): { id: string; address: string | null }[] {
  if (!Array.isArray(value) || !value.length) {
    throw new ApiError(
      422,
      "missing_required_field",
      "Missing `ids` field. Give a list of suppression ids.",
    );
  }

  if (value.length > MAX_BATCH) {
    throw validation(`A batch can have ${MAX_BATCH} or fewer ids.`);
  }

  const ids = new Set<string>();

  for (const id of value) {
    if (!isString(id)) throw validation("Each id must be a string.");
    ids.add(id);
  }

  return [...ids].map((id) => ({ id, address: addressOf(id) }));
}

// One page of the list, newest first. The cursor is an id.
export async function listSuppressions(
  env: Env,
  page: Page,
  origin?: string,
): Promise<{ rows: SuppressionRow[]; has_more: boolean }> {
  const where: string[] = [];
  const params: string[] = [];

  if (origin) {
    const reason = originToReason(origin);

    if (!reason) {
      throw new ApiError(
        422,
        "invalid_parameter",
        "The `origin` must be `bounce`, `complaint` or `manual`.",
      );
    }

    where.push("reason = ?");
    params.push(reason);
  }

  const cursor = page.after ?? page.before;
  const address = cursor ? addressOfId(cursor) : null;

  if (cursor && address === null) {
    throw new ApiError(422, "invalid_parameter", "The cursor id is not valid.");
  }

  return pageQuery<SuppressionRow>(
    env,
    "suppressions",
    where,
    params,
    page.after
      ? { ...page, after: address ?? undefined }
      : { ...page, before: address ?? undefined },
    "address",
  );
}
