import type { AttachmentMeta } from "../db/schema";
import type { Env } from "../env";
import type { EmailRow } from "../events/record";
import { hmac, safeEqual, toBase64Url } from "../lib/crypto";
import { ApiError, notFound } from "../lib/errors";
import type { Page } from "../lib/page";
import { sessionSecret } from "../lib/secrets";
import { iso } from "../lib/time";
import { getBody, getEmail } from "./manage";

// A download link works this long.
export const DOWNLOAD_TTL = 60 * 60 * 1000;

// The id of an attachment is its index in the list of the email. The list
// does not change after the send.
const INDEX = /^(0|[1-9]\d{0,3})$/;

// The Resend shape of an attachment, with a signed download link.
export interface AttachmentJson {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  content_disposition: "inline" | "attachment";
  content_id?: string;
  download_url: string;
  expires_at: string;
}

// The signature has its own prefix, so it never equals the signature of
// a click link (see tracking/sign.ts).
async function sign(
  secret: string,
  emailId: string,
  index: number,
  expires: number,
): Promise<string> {
  return toBase64Url(
    await hmac(secret, `attachment:${emailId}:${index}:${expires}`),
  ).slice(0, 32);
}

export async function checkDownload(
  env: Env,
  emailId: string,
  index: number,
  expires: string | undefined,
  sig: string | undefined,
): Promise<boolean> {
  const at = Number(expires);

  if (!sig || !Number.isInteger(at) || at < Date.now()) return false;

  return safeEqual(
    await sign(await sessionSecret(env), emailId, index, at),
    sig,
  );
}

async function toJson(
  env: Env,
  origin: string,
  email: EmailRow,
  index: number,
  meta: AttachmentMeta,
): Promise<AttachmentJson> {
  const expires = Date.now() + DOWNLOAD_TTL;
  const sig = await sign(await sessionSecret(env), email.id, index, expires);

  const out: AttachmentJson = {
    id: String(index),
    filename: meta.filename,
    size: meta.size,
    content_type: meta.content_type,
    content_disposition: meta.content_id ? "inline" : "attachment",
    download_url: `${origin}/emails/${email.id}/attachments/${index}/download?expires=${expires}&sig=${sig}`,
    expires_at: iso(expires),
  };

  if (meta.content_id) out.content_id = meta.content_id;

  return out;
}

// One page of the attachments of an email, in the order of the send. The
// cursor is an attachment id.
export async function listAttachments(
  env: Env,
  origin: string,
  emailId: string,
  page: Page,
): Promise<{ data: AttachmentJson[]; has_more: boolean }> {
  const email = await getEmail(env, emailId);
  const all = email.attachments ?? [];
  const limit = page.limit ?? 20;
  const cursor = page.after ?? page.before;
  let from = 0;
  let to = all.length;

  if (cursor !== undefined) {
    if (!INDEX.test(cursor) || Number(cursor) >= all.length) {
      throw new ApiError(
        422,
        "validation_error",
        "The cursor id does not exist.",
      );
    }

    if (page.after) from = Number(cursor) + 1;
    else to = Number(cursor);
  }

  // `before` reads the page that ends at the cursor.
  const start = page.before ? Math.max(from, to - limit) : from;
  const end = page.before ? to : Math.min(to, from + limit);

  const data = await Promise.all(
    all
      .slice(start, end)
      .map((meta, i) => toJson(env, origin, email, start + i, meta)),
  );

  return { data, has_more: page.before ? start > 0 : end < all.length };
}

export async function getAttachment(
  env: Env,
  origin: string,
  emailId: string,
  attachmentId: string,
): Promise<AttachmentJson> {
  const email = await getEmail(env, emailId);

  const meta = INDEX.test(attachmentId)
    ? email.attachments?.[Number(attachmentId)]
    : undefined;

  if (!meta) throw notFound("Attachment");

  return toJson(env, origin, email, Number(attachmentId), meta);
}

// The bytes of an attachment, for a download link that is valid.
export async function readAttachment(
  env: Env,
  emailId: string,
  index: number,
): Promise<{ bytes: Uint8Array; filename: string; contentType: string }> {
  const email = await getEmail(env, emailId);
  const body = await getBody(env, email);
  const a = body?.attachments[index];

  if (!a) {
    throw new ApiError(
      404,
      "not_found",
      "The attachment is not stored any more.",
    );
  }

  return {
    bytes: Uint8Array.from(atob(a.content), (ch) => ch.charCodeAt(0)),
    filename: a.filename,
    contentType: a.content_type,
  };
}
