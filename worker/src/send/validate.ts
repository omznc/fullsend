import * as chrono from "chrono-node";
import type { Tag } from "../db/schema";
import { type Address, parseAddress } from "../lib/address";
import { fromBase64, toBase64 } from "../lib/crypto";
import { ApiError, validation } from "../lib/errors";
import {
  isJsonObject,
  isString,
  type JsonObject,
  type JsonValue,
} from "../lib/json";
import { DAY } from "../lib/time";

// A type alias, not an interface, so that an Attachment is also a
// JsonObject.
export type Attachment = {
  filename: string;
  content: string; // base64
  content_type: string;
  content_id?: string;
  size: number;
};

export interface ValidEmail {
  from: string;
  fromAddress: Address;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  tags: Tag[] | null;
  attachments: Attachment[];
  scheduledAt: number | null;
}

export const MAX_RECIPIENTS = 50;

export const MAX_SIZE = 5 * 1024 * 1024;

const MAX_SCHEDULE = 30 * DAY;

const TAG = /^[A-Za-z0-9_-]{1,256}$/;

const ADDRESS_FORMAT =
  "The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.";

const missing = (field: string) =>
  new ApiError(422, "missing_required_field", `Missing \`${field}\` field.`);

function addressList(value: JsonValue | undefined, field: string): string[] {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];

  for (const item of list) {
    if (!isString(item) || !parseAddress(item)) {
      throw validation(`Invalid \`${field}\` field. ${ADDRESS_FORMAT}`);
    }

    out.push(item.trim());
  }

  return out;
}

// Parses ISO 8601 or natural language ("in 1 hour"), as Resend does.
export function parseSchedule(
  value: JsonValue | undefined,
  now = Date.now(),
): number | null {
  if (value == null || value === "") return null;

  if (!isString(value)) {
    throw validation("Invalid `scheduled_at` field.");
  }

  let at = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;

  if (Number.isNaN(at)) {
    const parsed = chrono.parseDate(value, new Date(now), {
      forwardDate: true,
    });

    at = parsed ? parsed.getTime() : NaN;
  }

  if (Number.isNaN(at)) {
    throw validation(
      "Invalid `scheduled_at` field. Use ISO 8601 or natural language, for example `in 1 hour`.",
    );
  }

  if (at - now > MAX_SCHEDULE) {
    throw validation("The `scheduled_at` must be 30 days or less from now.");
  }

  // A time in the past sends now.
  return at <= now ? null : at;
}

const MIME = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["txt", "text/plain"],
  ["csv", "text/csv"],
  ["html", "text/html"],
  ["ics", "text/calendar"],
  ["json", "application/json"],
  ["zip", "application/zip"],
  ["doc", "application/msword"],
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  ["xls", "application/vnd.ms-excel"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

function guessType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  return MIME.get(ext) ?? "application/octet-stream";
}

const FETCH_TIMEOUT = 10_000;

// Reads the file at an attachment `path`. The read stops at MAX_SIZE, so
// a large file cannot use up the memory of the Worker.
interface FetchedFile {
  bytes: Uint8Array;
  type: string | null;
  filename: string;
}

async function fetchAttachment(path: string, i: number): Promise<FetchedFile> {
  const bad = (message: string) =>
    new ApiError(422, "invalid_attachment", `Attachment ${i}: ${message}`);

  let url: URL;

  try {
    url = new URL(path);
  } catch {
    throw bad("`path` must be a URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw bad("`path` must be an http or https URL.");
  }

  let res: Response;

  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  } catch {
    throw bad("could not fetch `path`.");
  }

  if (!res.ok) throw bad(`\`path\` returned ${res.status}.`);
  const tooLarge = () => bad("the file at `path` is larger than 5 MiB.");

  if (Number(res.headers.get("content-length") ?? 0) > MAX_SIZE) {
    await res.body?.cancel();
    throw tooLarge();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    const reader = res.body?.getReader();

    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();

      if (done) break;
      total += value.byteLength;

      if (total > MAX_SIZE) {
        await reader.cancel();
        throw tooLarge();
      }

      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw bad("could not read `path`.");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }

  let filename = url.pathname.split("/").pop() ?? "";

  try {
    filename = decodeURIComponent(filename);
  } catch {
    // Keep the encoded name.
  }

  return {
    bytes,
    type: res.headers.get("content-type")?.split(";")[0] ?? null,
    filename,
  };
}

async function readAttachments(
  value: JsonValue | undefined,
): Promise<Attachment[]> {
  if (value == null) return [];

  if (!Array.isArray(value)) {
    throw new ApiError(
      422,
      "invalid_attachment",
      "The `attachments` field must be an array.",
    );
  }

  const out: Attachment[] = [];

  for (const [i, raw] of value.entries()) {
    if (!isJsonObject(raw)) {
      throw new ApiError(
        422,
        "invalid_attachment",
        `Invalid attachment at index ${i}.`,
      );
    }

    const path = isString(raw.path) ? raw.path : null;
    let filename = isString(raw.filename) ? raw.filename : "";
    let bytes: Uint8Array;
    let fetchedType: string | null = null;

    if (isString(raw.content)) {
      try {
        bytes = fromBase64(raw.content.replace(/\s+/g, ""));
      } catch {
        throw new ApiError(
          422,
          "invalid_attachment",
          `Attachment ${i}: \`content\` must be base64.`,
        );
      }
    } else if (path) {
      const fetched = await fetchAttachment(path, i);
      bytes = fetched.bytes;
      fetchedType = fetched.type;

      if (!filename) filename = fetched.filename;
    } else {
      throw new ApiError(
        422,
        "invalid_attachment",
        `Attachment ${i}: set \`content\` or \`path\`.`,
      );
    }

    if (!filename) {
      throw new ApiError(
        422,
        "invalid_attachment",
        `Attachment ${i}: missing \`filename\`.`,
      );
    }

    const contentType =
      (isString(raw.content_type) && raw.content_type) ||
      fetchedType ||
      guessType(filename);

    const attachment: Attachment = {
      filename,
      content: toBase64(bytes),
      content_type: contentType,
      size: bytes.byteLength,
    };

    if (isString(raw.content_id) && raw.content_id) {
      attachment.content_id = raw.content_id;
    }

    out.push(attachment);
  }

  return out;
}

export async function validateEmail(
  body: JsonValue,
  opts: { batch?: boolean } = {},
): Promise<ValidEmail> {
  if (!isJsonObject(body))
    throw validation("The request body must be a JSON object.");
  const b: JsonObject = body;

  if (b.template != null) {
    throw validation(
      "fullsend does not support templates. Send `html` or `text`.",
    );
  }

  if (b.from == null || b.from === "") throw missing("from");
  const from = isString(b.from) ? b.from : null;
  const fromAddress = from === null ? null : parseAddress(from);

  if (from === null || !fromAddress) {
    throw new ApiError(
      422,
      "invalid_from_address",
      `Invalid \`from\` field. ${ADDRESS_FORMAT}`,
    );
  }

  if (b.to == null || (Array.isArray(b.to) && b.to.length === 0))
    throw missing("to");
  const to = addressList(b.to, "to");
  const cc = addressList(b.cc, "cc");
  const bcc = addressList(b.bcc, "bcc");
  const replyTo = addressList(b.reply_to, "reply_to");

  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw validation(
      `The combined count of \`to\`, \`cc\` and \`bcc\` must be ${MAX_RECIPIENTS} or less.`,
    );
  }

  if (b.subject == null) throw missing("subject");

  if (!isString(b.subject))
    throw validation("The `subject` field must be a string.");

  const html = isString(b.html) && b.html ? b.html : null;
  const text = isString(b.text) && b.text ? b.text : null;

  if (!html && !text) throw validation("Missing `html` or `text` field.");

  let headers: Record<string, string> | null = null;

  if (b.headers != null) {
    if (!isJsonObject(b.headers))
      throw validation("The `headers` field must be an object.");
    headers = {};

    for (const [k, v] of Object.entries(b.headers)) {
      if (!isString(v)) throw validation(`Header \`${k}\` must be a string.`);
      headers[k] = v;
    }
  }

  let tags: Tag[] | null = null;

  if (b.tags != null) {
    if (!Array.isArray(b.tags))
      throw validation("The `tags` field must be an array.");
    tags = b.tags.map((t) => {
      if (
        !isJsonObject(t) ||
        !isString(t.name) ||
        !isString(t.value) ||
        !TAG.test(t.name) ||
        !TAG.test(t.value)
      ) {
        throw validation(
          "Tags should only contain ASCII letters (a–z, A–Z), numbers (0–9), underscores (_), or dashes (-).",
        );
      }

      return { name: t.name, value: t.value };
    });
  }

  if (opts.batch && b.attachments != null) {
    throw validation("The batch endpoint does not support `attachments`.");
  }

  if (opts.batch && b.scheduled_at != null) {
    throw validation("The batch endpoint does not support `scheduled_at`.");
  }

  const scheduledAt = parseSchedule(b.scheduled_at);
  const attachments = await readAttachments(b.attachments);

  const email: ValidEmail = {
    from,
    fromAddress,
    to,
    cc,
    bcc,
    replyTo,
    subject: b.subject,
    html,
    text,
    headers,
    tags,
    attachments,
    scheduledAt,
  };

  if (emailSize(email) > MAX_SIZE) {
    throw validation("The email is larger than 5 MiB, the Cloudflare limit.");
  }

  return email;
}

export function emailSize(
  email: Pick<ValidEmail, "html" | "text" | "attachments">,
): number {
  const enc = new TextEncoder();
  let size = 0;

  if (email.html) size += enc.encode(email.html).byteLength;

  if (email.text) size += enc.encode(email.text).byteLength;

  for (const a of email.attachments) size += a.size;

  return size;
}
