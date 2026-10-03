import type { Env } from "../env";
import type { JsonObject, JsonValue } from "./json";

export interface SystemEvent {
  level: "error" | "warn";
  // The part of fullsend that wrote the event, for example "send".
  source: string;
  message: string;
  // Extra data. Do not put an email body here.
  detail?: JsonObject;
  // Stored in `detail.payload` and never written to the log. It can hold
  // a recipient address, for example a dead queue message.
  payload?: JsonValue;
}

// The message of an error, for a log line or a system event.
export function errorText<E>(err: E): string {
  return err instanceof Error ? err.message : String(err);
}

// Stores a system event in D1 and writes one log line. It never throws:
// the caller is already handling a failure.
export async function logSystemEvent(env: Env, ev: SystemEvent): Promise<void> {
  const line = JSON.stringify({
    evt: ev.source,
    message: ev.message,
    ...ev.detail,
  });

  if (ev.level === "error") console.error(line);
  else console.warn(line);

  try {
    await env.DB.prepare(
      `INSERT INTO system_events (id, created_at, level, source, message, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        ev.level,
        ev.source,
        ev.message,
        ev.detail || ev.payload !== undefined
          ? JSON.stringify({ ...ev.detail, payload: ev.payload })
          : null,
      )
      .run();
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "system_event.insert_failed",
        error: errorText(err),
      }),
    );
  }
}
