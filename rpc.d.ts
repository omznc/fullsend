// Types of the fullsend RPC entrypoint. Copy this file into a Worker that
// calls fullsend over a service binding.
//
// wrangler.jsonc of the caller:
//   "services": [{
//     "binding": "FULLSEND",
//     "service": "fullsend",
//     "entrypoint": "FullsendRpc",
//     "props": { "caller": "my-worker" }
//   }]
//
// Env of the caller:
//   FULLSEND: Service<FullsendRpc>
//
// Each method returns `{ data, error }`, as the resend SDK does. A method
// does not throw for an API error.

export interface FullsendAttachment {
  // Base64 content, or `path` for a URL that fullsend fetches.
  content?: string;
  path?: string;
  filename?: string;
  content_type?: string;
  contentType?: string;
  // Set it to send the attachment inline (cid:<content_id>).
  content_id?: string;
  contentId?: string;
}

export interface FullsendEmail {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  // Cloudflare sends only the first reply-to address.
  reply_to?: string | string[];
  replyTo?: string | string[];
  headers?: Record<string, string>;
  attachments?: FullsendAttachment[];
  tags?: { name: string; value: string }[];
  // ISO 8601 or natural language ("in 1 hour"). 30 days or less.
  scheduled_at?: string;
  scheduledAt?: string;
}

export interface FullsendError {
  statusCode: number;
  name: string;
  message: string;
}

export type FullsendResult<T> =
  | { data: T; error: null }
  | { data: null; error: FullsendError };

export type FullsendEmailStatus =
  | "queued"
  | "scheduled"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "opened"
  | "clicked"
  | "failed"
  | "canceled"
  | "suppressed";

export interface FullsendListEmail {
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  subject: string;
  created_at: string;
  last_event: FullsendEmailStatus;
  scheduled_at: string | null;
  message_id: string | null;
}

export interface FullsendGetEmail extends FullsendListEmail {
  object: "email";
  html: string | null;
  text: string | null;
  tags: { name: string; value: string }[];
}

export interface FullsendRpc {
  sendEmail(
    email: FullsendEmail,
    options?: { idempotencyKey?: string },
  ): Promise<FullsendResult<{ id: string }>>;
  sendBatch(
    emails: Omit<
      FullsendEmail,
      "attachments" | "scheduled_at" | "scheduledAt"
    >[],
    options?: {
      idempotencyKey?: string;
      batchValidation?: "strict" | "permissive";
    },
  ): Promise<
    FullsendResult<{
      data: { id: string }[];
      errors?: { index: number; message: string }[];
    }>
  >;
  getEmail(id: string): Promise<FullsendResult<FullsendGetEmail>>;
  listEmails(options?: {
    limit?: number;
    after?: string;
    before?: string;
  }): Promise<
    FullsendResult<{
      object: "list";
      has_more: boolean;
      data: FullsendListEmail[];
    }>
  >;
  updateEmail(options: {
    id: string;
    scheduledAt: string;
  }): Promise<FullsendResult<{ object: "email"; id: string }>>;
  cancelEmail(
    id: string,
  ): Promise<FullsendResult<{ object: "email"; id: string }>>;
}
