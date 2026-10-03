import { env, exports } from "cloudflare:workers";
import { createKey } from "../src/keys/service";

export const BASE = "http://fullsend.test";

export async function call(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

// Routes global fetch calls for BASE to the Worker, so the resend SDK
// talks to fullsend.
export function routeFetchToWorker(): () => void {
  const original = globalThis.fetch;
  // SAFETY: the stub implements the (input, init) form of fetch. That is
  // the only form that the resend SDK calls.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);

    if (req.url.startsWith(BASE)) return exports.default.fetch(req);

    return original(req);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

export async function addDomain(
  name: string,
  status = "verified",
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO domains (id, name, status, open_tracking, click_tracking, records, source, created_at)
     VALUES (?, ?, ?, 1, 1, '[]', 'import', ?)`,
  )
    .bind(id, name, status, Date.now())
    .run();

  return id;
}

export async function newKey(
  opts: {
    permission?: "full_access" | "sending_access";
    domain_id?: string;
  } = {},
) {
  const { token, id } = await createKey(env, { name: "test", ...opts });

  return { token, id };
}

// The headers of a dashboard change: the JSON type and the CSRF guard.
export const DASH_JSON = {
  "Content-Type": "application/json",
  "X-Fullsend-Dashboard": "1",
};

// Makes a dashboard session in password mode. Returns the headers to use
// for each dashboard call. A call that changes data also needs
// X-Fullsend-Dashboard, so the headers have it.
export async function dashSession(): Promise<Record<string, string>> {
  await env.DB.prepare("DELETE FROM settings").run();

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .filter((c) => !c.endsWith("="))
      .at(-1) ?? "";

  const unlock = await call("/api/setup/unlock", {
    method: "POST",
    headers: DASH_JSON,
    body: JSON.stringify({ token: "test-setup-token" }),
  });

  const first = await call("/api/setup/password", {
    method: "POST",
    headers: { ...DASH_JSON, Cookie: cookieOf(unlock) },
    body: JSON.stringify({ password: "a test password 12" }),
  });

  return { ...DASH_JSON, Cookie: cookieOf(first) };
}
