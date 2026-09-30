import type { ReactNode } from "react";
import type { Domain } from "../../api";
import { Button, cx, Notice } from "../../components/ui";

// The parts that the eight steps of the setup wizard share.

// The state that the steps share. The wizard owns it.
export interface Flow {
  // The step of the URL, from 1 to 8.
  step: number;
  narrow: boolean;
  go: (step: number) => void;
  tokenSet: boolean;
  domain: Domain | null;
  setDomain: (d: Domain) => void;
  poll: Poll;
  hostnames: { api: string | null; tracking: string | null };
  setHostnames: (h: { api: string | null; tracking: string | null }) => void;
  key: { name: string; prefix: string } | null;
  setKey: (k: { name: string; prefix: string }) => void;
  tested: boolean;
  setTested: (v: boolean) => void;
}

// The client side of the verify loop.
export interface Poll {
  // Null until the first verify. "done" and "failed" end the loop.
  phase: "idle" | "running" | "done" | "failed";
  attempt: number;
  // The time of the next check, in ms, or null.
  nextAt: number | null;
  // True while a request is in flight.
  busy: boolean;
  start: (id: string) => void;
}

// A panel with a hint under a step.
export function Hint({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-panel px-3.5 py-3 text-[13.5px] text-fg2">
      {title && (
        <span className="mb-1 block text-[14px] font-semibold text-fg">
          {title}
        </span>
      )}
      {/* Text flows inline. Give each line of a list its own block. */}
      <div>{children}</div>
    </div>
  );
}

export const Mono = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => <code className={cx("font-mono text-fg", className)}>{children}</code>;

// A rule list. The list has a rule under each row and no rule above.
export function Rows({ children }: { children: ReactNode }) {
  return <div className="[clip-path:inset(0_0_1px_0)] -mb-px">{children}</div>;
}

export interface FooterProps {
  back: () => void;
  skip?: { label: string; onClick: () => void };
  second?: { label: string; icon: string; onClick: () => void; busy?: boolean };
  primary?: {
    label?: string;
    disabled?: boolean;
    busy?: boolean;
    onClick: () => void;
  };
}

// A step: the body, then the bar with back, skip and continue.
export function StepFrame({
  children,
  footer,
  narrow,
}: {
  children: ReactNode;
  footer?: FooterProps;
  narrow: boolean;
}) {
  const pad = narrow ? "px-4" : "px-8";

  return (
    <>
      <div
        className={cx(
          "flex max-w-[820px] flex-col gap-4",
          pad,
          narrow ? "py-4" : "pt-5 pb-7",
        )}
      >
        {children}
      </div>
      <span className="flex-1" />
      {footer && (
        // Sticky, so the next action stays in view on a long step.
        <div
          className={cx(
            "sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-line bg-bg py-3",
            pad,
          )}
        >
          <Button
            icon="chevron-left"
            onClick={footer.back}
            className={narrow ? "h-11" : "h-10"}
          >
            back
          </Button>
          {footer.skip && (
            <button
              type="button"
              onClick={footer.skip.onClick}
              className="h-10 border-0 bg-transparent px-2 font-mono text-[12.5px] text-fg2 hover:text-fg"
            >
              {footer.skip.label}
            </button>
          )}
          <span className="flex-1" />
          {footer.second && (
            <Button
              icon={footer.second.icon}
              busy={footer.second.busy}
              onClick={footer.second.onClick}
              className={narrow ? "h-11" : "h-10"}
            >
              {footer.second.label}
            </Button>
          )}
          {footer.primary && (
            <Button
              variant="primary"
              iconEnd="chevron-right"
              disabled={footer.primary.disabled}
              busy={footer.primary.busy}
              onClick={footer.primary.onClick}
              className={narrow ? "h-11" : "h-10"}
            >
              {footer.primary.label ?? "continue"}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

// Shown when a step needs a domain and the owner has none yet.
export function NeedDomain({ go }: { go: (step: number) => void }) {
  return (
    <Notice
      tone="amber"
      title="No domain yet"
      action={
        <Button size="sm" onClick={() => go(2)}>
          add a domain
        </Button>
      }
    >
      This step needs a sending domain. Add one in step 2.
    </Notice>
  );
}
