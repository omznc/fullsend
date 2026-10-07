import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { listEmails } from "../src/send/manage";
import { call } from "./helpers";

const json = {
  "Content-Type": "application/json",
  "X-Fullsend-Dashboard": "1",
};

async function addEmail(id: string, to: string, subject: string) {
  await env.DB.prepare(
    `INSERT INTO emails (id, api_key_id, "from", "to", subject, status, last_event, last_event_at, created_at)
     VALUES (?, 'k', 'a@send.example.com', ?, ?, 'sent', 'sent', 1, 1)`,
  )
    .bind(id, JSON.stringify([to]), subject)
    .run();
}

let cookie = "";

// 47 bytes. A LIKE pattern with the escape of this text is over the 50
// bytes that D1 allows.
const LONG = "customer.support_team@billing-department.example";

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).toSorted();

async function dash<T>(path: string): Promise<T> {
  const res = await call(path, { headers: { Cookie: cookie } });

  expect(res.status).toBe(200);

  return res.json<T>();
}

beforeAll(async () => {
  await addEmail("e1", "john_doe@x.com", "plain");
  await addEmail("e2", "johnxdoe@x.com", "plain");
  await addEmail("e3", "a@x.com", "50% off");
  await addEmail("e4", "b@x.com", "500 off");
  await addEmail("e5", "c@x.com", "back\\slash");
  await addEmail("e6", LONG, "long");
  await env.DB.prepare(
    "INSERT INTO suppressions (address, reason, source, created_at) VALUES ('john_doe@x.com', 'manual', 'test', 0), ('johnxdoe@x.com', 'manual', 'test', 0)",
  ).run();

  const unlock = await call("/api/setup/unlock", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ token: "test-setup-token" }),
  });

  const setup = unlock.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .at(-1)!;

  const res = await call("/api/setup/password", {
    method: "POST",
    headers: { ...json, Cookie: setup },
    body: JSON.stringify({ password: "correct horse battery" }),
  });

  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .at(-1)!;
});

describe("LIKE search", () => {
  it("matches an underscore as itself in the email list", async () => {
    const { emails } = await listEmails(env, {}, { q: "john_doe" });

    expect(ids(emails)).toEqual(["e1"]);
  });

  it("matches a percent sign and a backslash as themselves", async () => {
    expect(ids((await listEmails(env, {}, { q: "50%" })).emails)).toEqual([
      "e3",
    ]);
    expect(
      ids((await listEmails(env, {}, { q: "back\\slash" })).emails),
    ).toEqual(["e5"]);
  });

  it("finds the right row in the global search", async () => {
    const hit = await dash<{ emails: { id: string }[] }>(
      "/api/search?q=john_doe",
    );

    expect(ids(hit.emails)).toEqual(["e1"]);

    const pct = await dash<{ emails: { id: string }[] }>(
      "/api/search?q=" + encodeURIComponent("50%"),
    );

    expect(ids(pct.emails)).toEqual(["e3"]);
  });

  it("matches an underscore as itself in the suppression list", async () => {
    const list = await dash<{ data: { address: string }[] }>(
      "/api/suppressions?q=john_doe",
    );

    expect(list.data.map((s) => s.address)).toEqual(["john_doe@x.com"]);
  });

  it("searches a long text with an underscore", async () => {
    expect(
      ids((await listEmails(env, {}, { q: "Support_Team@Billing-" })).emails),
    ).toEqual(["e6"]);
    expect(ids((await listEmails(env, {}, { q: LONG })).emails)).toEqual([
      "e6",
    ]);

    const hit = await dash<{ emails: { id: string }[] }>(
      `/api/search?q=${LONG}`,
    );

    expect(ids(hit.emails)).toEqual(["e6"]);

    await env.DB.prepare(
      "INSERT INTO suppressions (address, reason, source, created_at) VALUES (?, 'manual', 'test', 0)",
    )
      .bind(LONG)
      .run();

    const list = await dash<{ data: { address: string }[] }>(
      `/api/suppressions?q=${LONG.toUpperCase()}`,
    );

    expect(list.data.map((x) => x.address)).toEqual([LONG]);
  });

  it("searches the request log with a long text", async () => {
    await env.DB.prepare(
      "INSERT INTO api_requests (id, created_at, method, path, status, duration_ms) VALUES ('long-log', 1, 'GET', ?, 200, 1)",
    )
      .bind(`/suppressions/${LONG}`)
      .run();

    const logs = await dash<{ data: { id: string }[] }>(`/api/logs?q=${LONG}`);

    expect(logs.data.map((x) => x.id)).toEqual(["long-log"]);
  });
});
