import type { Env } from "../env";
import type { JsonObject } from "./json";

export interface SystemEvent {
  level: "error" | "warn";
  // The part of fullsend that wrote the event, for example "send".
  source: string;
  message: string;
  // Extra data. Do not put an email body here.
  detail?: JsonObject;
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
        ev.detail ? JSON.stringify(ev.detail) : null,
      )
      .run();
  } catch (err) {
    console.error("system event insert failed", err);
  }
}
