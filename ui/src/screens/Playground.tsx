import { useState, type ReactNode } from "react";
import { api, ApiRequestError, type Domain } from "../api";
import {
  Badge,
  Button,
  CodeBlock,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  PageHeader,
  Select,
  SkeletonBlock,
  Tabs,
  tabPanelProps,
  Textarea,
  TextLink,
  cx,
} from "../components/ui";
import { useApi, useTitle } from "../lib/hooks";
import type { JsonObject } from "../lib/json";
import { apiBase, useSession } from "../session";

interface FormState {
  local: string;
  domain: string;
  to: string;
  cc: string;
  bcc: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  tags: string;
  headers: string;
  sendAt: string;
}

const SAMPLE_HTML = "<p>Hello from the fullsend playground.</p>";

// Splits a list of addresses that a person typed.
const list = (v: string) => v.split(/[,;\s]+/).filter(Boolean);

// Reads "name=value" pairs, split by a comma.
function parseTags(v: string) {
  return v
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.includes("="))
    .map((p) => {
      const at = p.indexOf("=");

      return { name: p.slice(0, at).trim(), value: p.slice(at + 1).trim() };
    })
    .filter((t) => t.name && t.value);
}

// Reads one "Name: value" header for each line.
function parseHeaders(v: string) {
  const out: Record<string, string> = {};

  for (const line of v.split("\n")) {
    const at = line.indexOf(":");

    if (at < 1) continue;
    const value = line.slice(at + 1).trim();

    if (value) out[line.slice(0, at).trim()] = value;
  }

  return out;
}

// The body of a send request, as the Worker reads it.
interface SendEmailBody {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  tags?: { name: string; value: string }[];
  headers?: Record<string, string>;
  scheduled_at?: string;
}

// The request body, as the Worker reads it. Empty fields stay out.
function buildPayload(f: FormState): SendEmailBody {
  const p: SendEmailBody = {
    from: `${f.local.trim() || "hello"}@${f.domain}`,
    to: list(f.to),
    subject: f.subject,
  };

  if (f.html.trim()) p.html = f.html;

  if (f.text.trim()) p.text = f.text;

  if (list(f.cc).length) p.cc = list(f.cc);

  if (list(f.bcc).length) p.bcc = list(f.bcc);

  if (list(f.replyTo).length) p.reply_to = list(f.replyTo);
  const tags = parseTags(f.tags);

  if (tags.length) p.tags = tags;
  const headers = parseHeaders(f.headers);

  if (Object.keys(headers).length) p.headers = headers;

  if (f.sendAt.trim() && f.sendAt.trim().toLowerCase() !== "now")
    p.scheduled_at = f.sendAt.trim();

  return p;
}

// The resend SDK reads camelCase names for two fields. The keys stay in
// the same order.
function sdkPayload(p: SendEmailBody): JsonObject {
  const out: JsonObject = {};

  for (const [k, v] of Object.entries(p)) {
    out[
      k === "reply_to" ? "replyTo" : k === "scheduled_at" ? "scheduledAt" : k
    ] = v;
  }

  return out;
}

const indent = (s: string, n: number) =>
  s
    .split("\n")
    .map((l, i) => (i ? " ".repeat(n) + l : l))
    .join("\n");

function snippets(base: string, p: SendEmailBody) {
  const json = JSON.stringify(p, null, 2);

  return [
    {
      label: "resend sdk",
      code: `import { Resend } from "resend";

const resend = new Resend("fs_...", { baseUrl: "${base}" });

const { data, error } = await resend.emails.send(${JSON.stringify(sdkPayload(p), null, 2)});`,
    },
    {
      label: "service binding",
      code: `// wrangler.jsonc of the caller: see the Docs page
const { data, error } = await env.FULLSEND.sendEmail(${indent(json, 0)});`,
    },
    {
      label: "curl",
      code: `curl -X POST ${base}/emails \\
  -H "Authorization: Bearer $FULLSEND_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${json.replace(/'/g, "'\\''")}'`,
    },
  ];
}

interface Result {
  ok: boolean;
  status: number;
  ms: number;
  body: unknown;
  id: string | null;
}

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-[52px] items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 md:grid-cols-[110px_minmax(0,1fr)] md:px-8">
      <label htmlFor={htmlFor} className="text-[13px] text-fg2">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Form({ domains }: { domains: Domain[] }) {
  const { session } = useSession();

  const [f, setF] = useState<FormState>({
    local: "hello",
    domain: domains[0]!.name,
    to: "",
    cc: "",
    bcc: "",
    replyTo: "",
    subject: "",
    html: SAMPLE_HTML,
    text: "",
    tags: "",
    headers: "",
    sendAt: "",
  });

  const [body, setBody] = useState<"html" | "text" | "preview">("html");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }));

  const payload = buildPayload(f);

  const ready =
    list(f.to).length > 0 &&
    f.subject.trim() !== "" &&
    (f.html.trim() !== "" || f.text.trim() !== "");

  const send = async () => {
    setBusy(true);
    const start = performance.now();

    try {
      const res = await api<{ id: string }>("/emails", {
        method: "POST",
        body: payload,
      });

      setResult({
        ok: true,
        status: 200,
        ms: Math.round(performance.now() - start),
        body: res,
        id: res.id,
      });
    } catch (err) {
      const e = err instanceof ApiRequestError ? err : null;
      setResult({
        ok: false,
        status: e?.status ?? 0,
        ms: Math.round(performance.now() - start),
        body: e?.body ?? { message: err instanceof Error ? err.message : "" },
        id: null,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid flex-1 md:grid-cols-2">
      <section className="flex min-w-0 flex-col border-line md:border-r">
        <Row label="From" htmlFor="pg-local">
          <Input
            id="pg-local"
            aria-label="Local part of the from address"
            value={f.local}
            onChange={(e) => set({ local: e.target.value })}
            className="max-w-[160px]"
          />
          <span className="text-fg3">@</span>
          <Select
            aria-label="Sending domain"
            value={f.domain}
            onChange={(v) => set({ domain: v })}
            options={domains.map((d) => ({ value: d.name, label: d.name }))}
          />
        </Row>
        <Row label="To" htmlFor="pg-to">
          <Input
            id="pg-to"
            value={f.to}
            placeholder="omar@example.com"
            onChange={(e) => set({ to: e.target.value })}
          />
        </Row>
        <Row label="Cc" htmlFor="pg-cc">
          <Input
            id="pg-cc"
            value={f.cc}
            placeholder="add address"
            onChange={(e) => set({ cc: e.target.value })}
          />
        </Row>
        <Row label="Bcc" htmlFor="pg-bcc">
          <Input
            id="pg-bcc"
            value={f.bcc}
            placeholder="add address"
            onChange={(e) => set({ bcc: e.target.value })}
          />
        </Row>
        <Row label="Reply to" htmlFor="pg-reply">
          <Input
            id="pg-reply"
            value={f.replyTo}
            placeholder="add address"
            onChange={(e) => set({ replyTo: e.target.value })}
          />
        </Row>
        <Row label="Subject" htmlFor="pg-subject">
          <Input
            id="pg-subject"
            value={f.subject}
            placeholder="Your sign-in link"
            onChange={(e) => set({ subject: e.target.value })}
          />
        </Row>
        <Tabs
          id="body"
          className="px-2 md:px-5"
          value={body}
          onChange={setBody}
          tabs={[
            { value: "html", label: "html" },
            { value: "text", label: "text" },
            { value: "preview", label: "preview" },
          ]}
        />
        <div {...tabPanelProps("body", body)} className="border-b border-line">
          {body === "html" && (
            <Textarea
              aria-label="HTML body"
              value={f.html}
              rows={7}
              spellCheck={false}
              onChange={(e) => set({ html: e.target.value })}
              className="border-0 bg-transparent px-4 md:px-8"
            />
          )}
          {body === "text" && (
            <Textarea
              aria-label="Text body"
              value={f.text}
              rows={7}
              onChange={(e) => set({ text: e.target.value })}
              className="border-0 bg-transparent px-4 md:px-8"
            />
          )}
          {body === "preview" &&
            (f.html.trim() ? (
              <iframe
                title="HTML preview"
                sandbox=""
                srcDoc={f.html}
                className="block h-[168px] w-full border-0 bg-white"
              />
            ) : (
              <p className="m-0 px-4 py-3.5 text-fg3 md:px-8">
                The HTML body is empty.
              </p>
            ))}
        </div>
        <Row label="Tags" htmlFor="pg-tags">
          <Input
            id="pg-tags"
            value={f.tags}
            placeholder="category=auth, plan=pro"
            onChange={(e) => set({ tags: e.target.value })}
          />
        </Row>
        <Row label="Headers" htmlFor="pg-headers">
          <Textarea
            id="pg-headers"
            rows={2}
            value={f.headers}
            placeholder="X-Entity-Ref-ID: 123"
            onChange={(e) => set({ headers: e.target.value })}
          />
        </Row>
        <Row label="Send at" htmlFor="pg-at">
          <Icon name="calendar" className="shrink-0 text-fg3" />
          <Input
            id="pg-at"
            value={f.sendAt}
            placeholder="now, or 2026-10-01T09:00:00Z, or in 1 hour"
            onChange={(e) => set({ sendAt: e.target.value })}
          />
        </Row>
        <div className="px-4 py-4 md:px-8">
          <Button
            variant="primary"
            icon="mail-arrow-right"
            busy={busy}
            disabled={!ready}
            onClick={() => void send()}
            className="h-11 md:h-10"
          >
            send
          </Button>
        </div>
      </section>
      <section className="flex min-w-0 flex-col border-t border-line bg-panel md:border-t-0">
        <CodeBlock
          tabs={snippets(apiBase(session), payload)}
          className="border-0 border-b"
        />
        {result ? (
          <div className="flex flex-col gap-2 px-4 py-3 md:px-6">
            <div className="flex items-center gap-2">
              <Badge
                status={result.ok ? "active" : "error"}
                label={String(result.status || "error")}
              />
              <span className="font-mono text-[12px] text-fg3">
                response · {result.ms} ms
              </span>
            </div>
            <pre className="m-0 overflow-x-auto bg-bg px-3 py-2.5 font-mono text-[12.5px] leading-5">
              {JSON.stringify(result.body, null, 2)}
            </pre>
            {result.id && (
              <TextLink
                href={`/emails/${result.id}`}
                iconEnd="arrow-right"
                className="font-mono text-[12.5px]"
              >
                open this email
              </TextLink>
            )}
          </div>
        ) : (
          <p className="m-0 px-4 py-3 text-[13px] text-fg3 md:px-6">
            The result of a send shows here.
          </p>
        )}
      </section>
    </div>
  );
}

function FormSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className={cx(
            "flex h-[52px] items-center gap-3 border-b border-line px-4 md:px-8",
          )}
        >
          <SkeletonBlock className="h-2.5 w-[90px]" />
          <SkeletonBlock className="h-9 flex-1" />
        </div>
      ))}
    </div>
  );
}

export function Playground() {
  useTitle("Playground");
  const res = useApi<{ data: Domain[] }>("/domains");
  const verified = res.data?.data.filter((d) => d.status === "verified") ?? [];

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        title="Playground"
        subtitle="Send a real email from here. The right side shows the same request as code."
        actions={
          <span className="tint-amber inline-flex h-7 items-center gap-1.5 px-2 font-mono text-[12px]">
            <Icon name="warning-box" size={16} />
            this form sends a real email
          </span>
        }
      />
      <div className="border-t border-line" />
      {res.error && !res.data ? (
        <ErrorState
          error={res.error}
          title="Could not load the domains"
          onRetry={() => void res.reload()}
        />
      ) : !res.data ? (
        <FormSkeleton />
      ) : verified.length === 0 ? (
        <EmptyState
          icon="mail"
          title="No verified domain yet"
          action={
            <TextLink href="/domains" iconEnd="arrow-right">
              open domains
            </TextLink>
          }
        >
          fullsend sends only from a verified domain. Add a domain and verify
          its DNS records first.
        </EmptyState>
      ) : (
        <Form domains={verified} />
      )}
    </div>
  );
}
