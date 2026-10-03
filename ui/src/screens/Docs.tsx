import { Fragment } from "react";
import { CodeBlock, CopyButton, Icon, TextLink, cx } from "../components/ui";
import { useApi, useTitle } from "../lib/hooks";
import { apiBase, useSession } from "../session";

const METHOD_COLOR = {
  POST: "text-green",
  GET: "text-blue",
  PATCH: "text-amber",
  DELETE: "text-red",
};

interface Endpoint {
  m: keyof typeof METHOD_COLOR;
  p: string;
  d: string;
}

// The public routes of worker/src/api/.
const GROUPS: { id: string; title: string; eps: Endpoint[] }[] = [
  {
    id: "emails",
    title: "Emails",
    eps: [
      { m: "POST", p: "/emails", d: "Send an email" },
      { m: "POST", p: "/emails/batch", d: "Send up to 100 emails" },
      { m: "GET", p: "/emails", d: "List emails" },
      { m: "GET", p: "/emails/:id", d: "Get one email and its status" },
      { m: "PATCH", p: "/emails/:id", d: "Reschedule a scheduled email" },
      { m: "POST", p: "/emails/:id/cancel", d: "Cancel a scheduled email" },
    ],
  },
  {
    id: "domains",
    title: "Domains",
    eps: [
      { m: "POST", p: "/domains", d: "Add a domain" },
      { m: "GET", p: "/domains", d: "List domains" },
      { m: "GET", p: "/domains/:id", d: "Get one domain and its DNS records" },
      { m: "POST", p: "/domains/:id/verify", d: "Check DNS again" },
      { m: "PATCH", p: "/domains/:id", d: "Change the tracking of a domain" },
      { m: "DELETE", p: "/domains/:id", d: "Delete a domain" },
    ],
  },
  {
    id: "api-keys",
    title: "API keys",
    eps: [
      { m: "POST", p: "/api-keys", d: "Make a key" },
      { m: "GET", p: "/api-keys", d: "List keys" },
      { m: "DELETE", p: "/api-keys/:id", d: "Revoke a key" },
    ],
  },
  {
    id: "webhooks",
    title: "Webhooks",
    eps: [
      { m: "POST", p: "/webhooks", d: "Add a webhook" },
      { m: "GET", p: "/webhooks", d: "List webhooks" },
      { m: "GET", p: "/webhooks/:id", d: "Get one webhook" },
      { m: "PATCH", p: "/webhooks/:id", d: "Change a webhook" },
      { m: "DELETE", p: "/webhooks/:id", d: "Delete a webhook" },
      {
        m: "POST",
        p: "/webhooks/:id/signing-secret/rotate",
        d: "Make a new signing secret",
      },
    ],
  },
];

const DIFFS: { icon: string; color: string; title: string; text: string }[] = [
  {
    icon: "file",
    color: "text-amber",
    title: "5 MiB for each message.",
    text: "Body and attachments together. This is the Cloudflare limit.",
  },
  {
    icon: "mail",
    color: "text-amber",
    title: "One reply-to address.",
    text: "Cloudflare sends only the first reply_to address.",
  },
  {
    icon: "close",
    color: "text-red",
    title: "No templates, audiences, contacts, broadcasts or receiving.",
    text: "fullsend sends transactional email only.",
  },
  {
    icon: "server",
    color: "text-amber",
    title: "Domains must be in your Cloudflare account.",
    text: "Each domain must be in a zone of the same account.",
  },
  {
    icon: "check",
    color: "text-green",
    title: "Same request and response shapes.",
    text: "The error names, Idempotency-Key and x-batch-validation work as in Resend. Keys start with fs_.",
  },
];

const TOC: {
  title: string;
  items: { id: string; label: string; meta?: string }[];
}[] = [
  {
    title: "Getting started",
    items: [
      { id: "base-url", label: "Base URL and auth" },
      { id: "moving", label: "Moving from Resend" },
      { id: "rate-limits", label: "Rate limits" },
      { id: "differences", label: "Differences" },
    ],
  },
  {
    title: "API",
    items: GROUPS.map((g) => ({
      id: g.id,
      label: g.title,
      meta: String(g.eps.length),
    })),
  },
  {
    title: "Examples",
    items: [
      { id: "snippets", label: "Snippets", meta: "3" },
      { id: "webhook-verify", label: "Verify a signature" },
    ],
  },
];

const jump = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ block: "start" });

function H2({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="m-0 scroll-mt-4 text-[17px] font-semibold">
      {children}
    </h2>
  );
}

const code = "font-mono text-fg";

export function Docs() {
  useTitle("Docs");
  const { session } = useSession();
  const base = apiBase(session);
  const hooks = useApi<{ events: string[] }>("/webhooks");
  const events = hooks.data?.events ?? [];

  const snippets = [
    {
      label: "resend sdk",
      code: `import { Resend } from "resend";

const resend = new Resend("fs_...", { baseUrl: "${base}" });

await resend.emails.send({
  from: "Acme <hello@example.com>",
  to: ["omar@example.net"],
  subject: "Hello",
  html: "<p>Hello</p>",
});`,
    },
    {
      label: "service binding",
      code: `// wrangler.jsonc of the app that sends email
"services": [
  { "binding": "FULLSEND", "service": "fullsend", "entrypoint": "FullsendRpc", "props": { "caller": "my-worker" } }
]

// no network hop, no API key needed inside your account
const { data, error } = await env.FULLSEND.sendEmail({ from, to, subject, html });`,
    },
    {
      label: "curl",
      code: `curl -X POST ${base}/emails \\
  -H "Authorization: Bearer $FULLSEND_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"from":"hello@example.com","to":"omar@example.net","subject":"Hello","text":"Hello"}'`,
    },
  ];

  const verify = [
    {
      label: "svix",
      code: `import { Webhook } from "svix";

// The secret starts with whsec_. Read the raw body, not parsed JSON.
const wh = new Webhook(process.env.WEBHOOK_SECRET!);

const event = wh.verify(rawBody, {
  "svix-id": request.headers.get("svix-id")!,
  "svix-timestamp": request.headers.get("svix-timestamp")!,
  "svix-signature": request.headers.get("svix-signature")!,
});`,
    },
  ];

  return (
    <div className="grid flex-1 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_320px]">
      <nav
        aria-label="Docs"
        className="hidden flex-col border-r border-line lg:flex"
      >
        {TOC.map((g) => (
          <div
            key={g.title}
            className="flex flex-col border-b border-line py-3"
          >
            <span className="px-4 pt-1 pb-1.5 text-[13px] font-semibold">
              {g.title}
            </span>
            {g.items.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => jump(t.id)}
                className="mx-2 flex min-h-8 items-center justify-between gap-2 border-0 bg-transparent px-2 text-left text-[13.5px] text-fg2 hover:bg-hover hover:text-fg"
              >
                <span>{t.label}</span>
                {t.meta && (
                  <span className="font-mono text-[11.5px] text-fg3">
                    {t.meta}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <main className="flex min-w-0 max-w-[860px] flex-col gap-7 px-4 py-6 md:px-10 md:pt-7 md:pb-12">
        <div>
          <h1 className="m-0 mb-1.5 text-[26px] leading-8 font-semibold tracking-[-0.02em]">
            Docs
          </h1>
          <p className="m-0 text-fg2">
            fullsend speaks the Resend API. If your app already uses the Resend
            SDK, change two values and it sends through this deploy.
          </p>
        </div>

        <section className="flex flex-col gap-2.5">
          <H2 id="base-url">Base URL and auth</H2>
          <div className="flex h-11 items-center border border-line2 bg-panel pr-1 pl-3 font-mono text-[13px]">
            <span className="min-w-0 flex-1 truncate">{base}</span>
            <CopyButton text={base} label="Copy base URL" size={40} />
          </div>
          <p className="m-0 text-fg2">
            Send your key as{" "}
            <code className={code}>Authorization: Bearer fs_...</code>. Keys are
            made on the <TextLink href="/api-keys">API keys</TextLink> page. A
            key with the sending permission can call only the send routes.
          </p>
        </section>

        <section className="flex flex-col gap-2.5">
          <H2 id="moving">Moving from Resend</H2>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-fg2">
            <li>1. Make a key on the API keys page.</li>
            <li>
              2. Set <code className={code}>baseUrl</code> (or the{" "}
              <code className={code}>RESEND_BASE_URL</code> variable) to your
              API hostname.
            </li>
            <li>
              3. Send a test from the{" "}
              <TextLink href="/playground" iconEnd="arrow-right">
                Playground
              </TextLink>
              .
            </li>
          </ol>
        </section>

        <section className="flex flex-col gap-2.5">
          <H2 id="rate-limits">Rate limits</H2>
          <p className="m-0 text-fg2">
            Each API key has a limit in requests per second. The default is set
            in <TextLink href="/settings">Settings</TextLink>. You can change it
            for one key. The limit has steps of 10 requests per second. A
            request over the limit gets the error{" "}
            <code className={code}>429 rate_limit_exceeded</code>.
          </p>
        </section>

        <section className="flex flex-col">
          <h2 className="m-0 mb-2.5 text-[17px] font-semibold">
            Supported endpoints
          </h2>
          {GROUPS.map((g) => (
            <div key={g.id} id={g.id} className="scroll-mt-4">
              <div className="mt-3 mb-1 text-[13px] font-semibold">
                {g.title}
              </div>
              <div className="hidden h-9 grid-cols-[80px_minmax(0,320px)_minmax(0,1fr)] items-center gap-3.5 border-y border-line font-mono text-[12px] text-fg3 md:grid">
                <span>method</span>
                <span>path</span>
                <span>what it does</span>
              </div>
              {g.eps.map((e) => (
                <div
                  key={e.m + e.p}
                  className="grid min-h-10 items-center gap-x-3.5 border-b border-line py-1.5 max-md:border-t-0 md:grid-cols-[80px_minmax(0,320px)_minmax(0,1fr)]"
                >
                  <span
                    className={cx(
                      "font-mono text-[12px] font-semibold",
                      METHOD_COLOR[e.m],
                    )}
                  >
                    {e.m}
                  </span>
                  <span className="font-mono text-[12.5px] [overflow-wrap:anywhere]">
                    {e.p}
                  </span>
                  <span className="text-[13.5px] text-fg2">{e.d}</span>
                </div>
              ))}
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-2.5">
          <H2 id="differences">Differences from Resend</H2>
          {DIFFS.map((d) => (
            <div key={d.title} className="flex items-start gap-2.5">
              <Icon name={d.icon} className={cx("shrink-0", d.color)} />
              <span>
                <span className="font-semibold">{d.title}</span>{" "}
                <span className="text-fg2">{d.text}</span>
              </span>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-2.5">
          <H2 id="snippets">Snippets</H2>
          <CodeBlock tabs={snippets} />
          <p className="m-0 text-fg2">
            The service binding needs <code className={code}>rpc.d.ts</code>{" "}
            from the repository. The methods are{" "}
            <code className={code}>sendEmail</code>,{" "}
            <code className={code}>sendBatch</code>,{" "}
            <code className={code}>getEmail</code>,{" "}
            <code className={code}>listEmails</code>,{" "}
            <code className={code}>updateEmail</code> and{" "}
            <code className={code}>cancelEmail</code>. They return{" "}
            <code className={code}>{"{ data, error }"}</code>.
          </p>
        </section>

        <section className="flex flex-col gap-2.5">
          <H2 id="webhook-verify">Verify a signature</H2>
          <p className="m-0 text-fg2">
            fullsend signs each webhook as Svix does, with the Resend body. The
            headers are <code className={code}>svix-id</code>,{" "}
            <code className={code}>svix-timestamp</code> and{" "}
            <code className={code}>svix-signature</code>. The{" "}
            <code className={code}>svix</code> package and{" "}
            <code className={code}>resend.webhooks.verify()</code> check them.
            {events.length > 0 && (
              <>
                The events are{" "}
                {events.map((e, i) => (
                  <Fragment key={e}>
                    {i > 0 && (i === events.length - 1 ? " and " : ", ")}
                    <code className={code}>{e}</code>
                  </Fragment>
                ))}
                .
              </>
            )}
          </p>
          <CodeBlock tabs={verify} />
        </section>
      </main>
      <aside className="hidden flex-col gap-3 border-l border-line bg-panel px-6 py-7 xl:flex">
        <span className="mb-1 text-[14px] font-semibold">
          Moving from Resend
        </span>
        <span className="text-[13.5px] text-fg2">
          1. Make a key on the API keys page.
        </span>
        <span className="text-[13.5px] text-fg2">
          2. Set <code className={code}>baseUrl</code> to your API hostname.
        </span>
        <span className="text-[13.5px] text-fg2">
          3. Send a test from the Playground.
        </span>
        <TextLink
          href="/playground"
          iconEnd="arrow-right"
          className="font-mono text-[12.5px]"
        >
          open playground
        </TextLink>
      </aside>
    </div>
  );
}
