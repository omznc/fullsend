import { useState } from "react";
import type { Domain } from "../api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Notice,
  PageHeader,
  Skeleton,
  TableHead,
  TableRow,
} from "../components/ui";
import { utc } from "../lib/format";
import { useApi, useTitle } from "../lib/hooks";
import { AddDomain } from "./domains/AddDomain";

const COLS = "minmax(0,1.4fr) 160px 140px 170px 170px 140px 40px";

interface DomainList {
  data: Domain[];
  can_manage: boolean;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

// A short line under the name when the domain cannot send yet.
function noteOf(d: Domain): string | null {
  if (d.status === "verified") return null;
  const open = d.records.filter((r) => r.status !== "verified").length;

  if (open === 0) return "Email from here is not sent yet.";

  return `${open} of ${d.records.length} DNS ${open === 1 ? "record is" : "records are"} not verified. Email from here is not sent yet.`;
}

function Tracking({ on, name }: { on: boolean; name: string }) {
  return (
    <span className="flex items-center gap-0.5 font-mono text-[12.5px]">
      <Icon
        name={on ? "toggle-right" : "toggle-left"}
        className={on ? "text-accent-fg" : "text-fg3"}
      />
      <span className="sr-only">{name} tracking </span>
      {on ? "on" : "off"}
    </span>
  );
}

export function Domains() {
  useTitle("Domains");
  const { data, error, loading, reload } = useApi<DomainList>("/domains");
  const [panel, setPanel] = useState(false);
  const canManage = data?.can_manage ?? false;
  const rows = data?.data ?? [];

  const add = data && (
    <Button
      variant="primary"
      icon={canManage ? "plus" : "cloud-download"}
      onClick={() => setPanel(true)}
    >
      {canManage ? "add domain" : "import from cloudflare"}
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Domains"
        subtitle="The addresses your email comes from. Each one needs a few DNS records before it can send."
        actions={add}
      />
      {data && !canManage && (
        <div className="px-4 pb-4 md:px-8">
          <Notice
            tone="amber"
            icon="lock"
            title="Read-only: no Cloudflare token."
          >
            fullsend can show domains but cannot add or verify them. Add a token
            in Settings, or import domains you already set up in Cloudflare.
          </Notice>
        </div>
      )}
      {error && !data && (
        <ErrorState
          error={error}
          title="Could not load domains"
          onRetry={() => void reload()}
        />
      )}
      {loading && !data && (
        <>
          <TableHead
            template={COLS}
            columns={[
              "name",
              "status",
              "region",
              "open tracking",
              "click tracking",
              "created",
              "",
            ]}
          />
          <Skeleton rows={3} widths={["40%", "55%", "35%"]} />
        </>
      )}
      {data && rows.length === 0 && (
        <EmptyState icon="server" title="No domains yet" action={add}>
          Add a domain to start sending. We suggest a subdomain like
          mail.yourcompany.com.
        </EmptyState>
      )}
      {rows.length > 0 && (
        <div role="group" aria-label="Domains">
          <TableHead
            template={COLS}
            columns={[
              "name",
              "status",
              "region",
              "open tracking",
              "click tracking",
              "created",
              "",
            ]}
          />
          {rows.map((d) => {
            const note = noteOf(d);

            return (
              <TableRow
                key={d.id}
                template={COLS}
                href={`/domains/${d.id}`}
                className={canManage ? undefined : "opacity-75"}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-mono text-[13px] font-semibold [overflow-wrap:anywhere]">
                    {d.name}
                  </span>
                  {note && (
                    <span className="text-[12.5px] text-amber">{note}</span>
                  )}
                </span>
                <span>
                  <Badge status={d.status} />
                </span>
                <span className="font-mono text-[12.5px] text-fg2">
                  {d.region}
                </span>
                <Tracking on={d.open_tracking} name="Open" />
                <Tracking on={d.click_tracking} name="Click" />
                <span
                  className="font-mono text-[12px] text-fg2"
                  title={utc(d.created_at)}
                >
                  {day(d.created_at)}
                </span>
                <Icon
                  name="chevron-right"
                  className="hidden text-fg3 md:block"
                />
              </TableRow>
            );
          })}
          <p className="m-0 px-4 py-3.5 text-[13px] text-fg2 md:px-8">
            Each domain has its own open and click tracking setting. Turn them
            off if you do not want tracking pixels or rewritten links.
          </p>
        </div>
      )}
      <AddDomain
        open={panel}
        canManage={canManage}
        existing={rows.map((d) => d.name)}
        onClose={() => setPanel(false)}
        onChanged={() => void reload()}
      />
    </>
  );
}
