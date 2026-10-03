import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { ApiError, type ErrorBody } from "./lib/errors";
import { isJsonObject, type JsonObject, type JsonValue } from "./lib/json";
import { errorText } from "./lib/system-events";
import { createBatch, createEmail } from "./send/create";
import { withIdempotency } from "./send/idempotency";
import {
  cancelEmail,
  emailJson,
  emailListJson,
  getBody,
  getEmail,
  listEmails,
  reschedule,
} from "./send/manage";

// The service binding can pass `props: { caller: "<name>" }`. The name
// shows in the api_key_id column as "rpc:<name>".
interface Props {
  caller?: string;
}

type Result<T> = { data: T; error: null } | { data: null; error: ErrorBody };

// Accepts the camelCase names of the resend SDK (`replyTo`,
// `scheduledAt`, `contentType`) as well as the API names.
export function toApiBody(body: JsonValue): JsonValue {
  if (!isJsonObject(body)) return body;
  const b: JsonObject = { ...body };

  const rename = (from: string, to: string, obj: JsonObject) => {
    if (obj[from] !== undefined && obj[to] === undefined) obj[to] = obj[from];
    delete obj[from];
  };

  rename("replyTo", "reply_to", b);
  rename("scheduledAt", "scheduled_at", b);

  if (Array.isArray(b.attachments)) {
    b.attachments = b.attachments.map((a) => {
      if (!isJsonObject(a)) return a;
      const copy: JsonObject = { ...a };
      rename("contentType", "content_type", copy);
      rename("contentId", "content_id", copy);

      return copy;
    });
  }

  return b;
}

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { data: await fn(), error: null };
  } catch (err) {
    if (err instanceof ApiError) return { data: null, error: err.toBody() };
    console.error(JSON.stringify({ evt: "rpc.error", error: errorText(err) }));

    return {
      data: null,
      error: {
        statusCode: 500,
        name: "application_error",
        message: "Internal server error. Try again later.",
      },
    };
  }
}

// RPC entrypoint for a Worker in the same account. The caller uses a
// service binding, not an API key. The methods take the Resend request bodies and return
// `{ data, error }`, as the resend SDK does.
export class FullsendRpc extends WorkerEntrypoint<Env, Props> {
  private get apiKeyId(): string {
    return `rpc:${this.ctx.props?.caller ?? "worker"}`;
  }

  // The caller sends a structured clone of a FullsendEmail (rpc.d.ts).
  // validateEmail checks each field of it.
  sendEmail(body: JsonValue, options: { idempotencyKey?: string } = {}) {
    return wrap(() =>
      withIdempotency(
        this.env,
        this.apiKeyId,
        options.idempotencyKey,
        `email:${JSON.stringify(body)}`,
        () =>
          createEmail(this.env, toApiBody(body), { apiKeyId: this.apiKeyId }),
      ),
    );
  }

  sendBatch(
    body: JsonValue,
    options: {
      idempotencyKey?: string;
      batchValidation?: "strict" | "permissive";
    } = {},
  ) {
    const mode = options.batchValidation ?? "strict";

    return wrap(() =>
      withIdempotency(
        this.env,
        this.apiKeyId,
        options.idempotencyKey,
        `batch:${mode}:${JSON.stringify(body)}`,
        () =>
          createBatch(
            this.env,
            Array.isArray(body) ? body.map(toApiBody) : body,
            { apiKeyId: this.apiKeyId },
            mode,
          ),
      ),
    );
  }

  getEmail(id: string) {
    return wrap(async () => {
      const email = await getEmail(this.env, id);

      return emailJson(email, await getBody(this.env, email));
    });
  }

  listEmails(
    options: { limit?: number; after?: string; before?: string } = {},
  ) {
    return wrap(async () => {
      const { emails, has_more } = await listEmails(this.env, options);

      return {
        object: "list" as const,
        has_more,
        data: emails.map(emailListJson),
      };
    });
  }

  updateEmail(options: { id: string; scheduledAt: string }) {
    return wrap(async () => {
      const email = await reschedule(this.env, options.id, options.scheduledAt);

      return { object: "email" as const, id: email.id };
    });
  }

  cancelEmail(id: string) {
    return wrap(async () => {
      await cancelEmail(this.env, id);

      return { object: "email" as const, id };
    });
  }
}
