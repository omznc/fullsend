import { applyD1Migrations, env } from "cloudflare:test";
import { vi } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The reply of a stub queue. fullsend does not read it.
const SENT: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

// Stub the three producer bindings. A real message goes to the queue
// consumer, and workerd runs the consumer after the test file ends. At
// that time the vitest state is gone, and workerd prints "Expected global
// Vitest state". A test that needs the consumer calls it by hand.
for (const queue of [env.SEND_QUEUE, env.HOOKS_QUEUE, env.EVENTS_QUEUE]) {
  vi.spyOn(queue, "send").mockResolvedValue(SENT);
  vi.spyOn(queue, "sendBatch").mockResolvedValue(SENT);
}
