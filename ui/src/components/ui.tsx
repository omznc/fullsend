import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  createContext,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ApiRequestError } from "../api";
import { number, relative, utc } from "../lib/format";
import { EXIT_MS, useDismiss, useNow, usePresence } from "../lib/hooks";
import { Link } from "../lib/router";

// The shared components of the Story design system. Square corners,
// rules instead of cards, lime as the only accent.

export const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

// Icons

// A pixelarticons glyph. 24 px on its own, 16 px in buttons and links.
export function Icon({
  name,
  size = 24,
  className,
  label,
}: {
  name: string;
  size?: 16 | 24 | 32 | 48;
  className?: string;
  label?: string;
}) {
  return (
    <i
      className={cx(`pixelart-icons-font-${name}`, className)}
      style={{ fontSize: size }}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}

export function Logo({ size = 15 }: { size?: number }) {
  return (
    <span
      className="font-mono font-bold tracking-[-0.04em]"
      style={{ fontSize: size }}
    >
      <span className="font-normal text-fg2">full</span>send
    </span>
  );
}

// Buttons

type Variant = "primary" | "secondary" | "danger" | "danger-solid" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary:
    "border-0 bg-accent text-accent-ink font-semibold hover:bg-[color-mix(in_oklab,var(--accent)_80%,var(--fg))]",
  secondary:
    "border border-line2 bg-transparent text-fg font-medium hover:bg-hover",
  danger:
    "border border-line2 bg-transparent text-red font-medium hover:bg-hover",
  "danger-solid":
    "border-0 bg-red text-bg font-semibold hover:bg-[color-mix(in_oklab,var(--red)_85%,var(--fg))]",
  ghost: "border-0 bg-transparent text-fg2 font-medium hover:text-fg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: string;
  // An icon after the label, for "next" and similar.
  iconEnd?: string;
  size?: "md" | "sm";
  busy?: boolean;
}

export function Button({
  variant = "secondary",
  icon,
  iconEnd,
  size = "md",
  busy,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const off = disabled || busy;

  return (
    <button
      type={type}
      disabled={off}
      aria-busy={busy || undefined}
      className={cx(
        "press inline-flex shrink-0 items-center gap-1.5 font-mono whitespace-nowrap",
        size === "md" ? "h-9 text-[12.5px]" : "h-8 text-[12px]",
        icon ? "pr-3.5 pl-3" : iconEnd ? "pr-2 pl-2.5" : "px-3.5",
        off ? "border-0 bg-raised font-semibold text-fg3" : VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {busy ? (
        <Icon name="reload" size={16} className="animate-spin" />
      ) : (
        icon && <Icon name={icon} size={16} />
      )}
      {children}
      {iconEnd && <Icon name={iconEnd} size={16} />}
    </button>
  );
}

// An icon-only button: 32 px square, or 44 px on touch layouts.
export function IconButton({
  icon,
  label,
  size = 32,
  className,
  bordered,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: string;
  label: string;
  size?: 32 | 40 | 44;
  bordered?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "press-icon grid shrink-0 place-items-center bg-transparent text-fg2 hover:text-fg",
        bordered ? "border border-line2" : "border-0",
        className,
      )}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

// A link that looks like a button.
export function ButtonLink({
  href,
  variant = "secondary",
  icon,
  children,
  className,
}: {
  href: string;
  variant?: Variant;
  icon?: string;
  children: ReactNode;
  className?: string;
}) {
  const external = !href.startsWith("/");

  return (
    <Link
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={cx(
        "press inline-flex h-9 shrink-0 items-center gap-1.5 font-mono text-[12.5px] whitespace-nowrap no-underline",
        icon ? "pr-3.5 pl-3" : "px-3.5",
        VARIANT[variant],
        variant === "primary" && "hover:text-accent-ink",
        className,
      )}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </Link>
  );
}

// A text link with an optional icon. Only the words are underlined.
export function TextLink({
  href,
  icon,
  iconEnd,
  children,
  className,
}: {
  href: string;
  icon?: string;
  iconEnd?: string;
  children: ReactNode;
  className?: string;
}) {
  const external = /^https?:/.test(href);

  return (
    <Link
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      className={cx(
        "inline-flex items-center gap-1 no-underline [&>span]:underline [&>span]:underline-offset-3",
        className,
      )}
    >
      {icon && <Icon name={icon} size={16} />}
      <span>{children}</span>
      {(iconEnd ?? (external ? "external-link" : undefined)) && (
        <Icon name={iconEnd ?? "external-link"} size={16} />
      )}
    </Link>
  );
}

// Animated numbers

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// The same spring as --spring in index.css, as a function of t in 0..1.
const springAt = (t: number) =>
  t >= 1 ? 1 : 1 - (1 + 9.2 * t) * Math.exp(-9.2 * t);

const wholeNumber = (v: number) => number(Math.round(v));

// A number that counts to its new value. A new value during the count
// starts from the number on screen, so the count never jumps. The digits
// are tabular, so the width does not shake. A screen reader reads only
// the final value.
export function AnimatedNumber({
  value,
  format = wholeNumber,
  className,
}: {
  value: number;
  format?: (v: number) => string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const fmt = useRef(format);
  useEffect(() => {
    fmt.current = format;
  });
  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) return;
    const from = shown.current;

    if (from === null || from === value || reduceMotion.matches) {
      shown.current = value;
      el.textContent = fmt.current(value);

      return;
    }

    const start = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const v = from + (value - from) * springAt(t);
      shown.current = v;
      el.textContent = fmt.current(v);

      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <span className={cx("tabular-nums", className)}>
      <span ref={ref} aria-hidden />
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}

// Status badge

export type Tone = "gray" | "blue" | "green" | "amber" | "red" | "cyan";

const TONE = new Map<string, Tone>([
  ["queued", "gray"],
  ["scheduled", "blue"],
  ["sent", "blue"],
  ["delivered", "green"],
  ["delivery_delayed", "amber"],
  ["bounced", "red"],
  ["complained", "red"],
  ["opened", "cyan"],
  ["clicked", "cyan"],
  ["failed", "red"],
  ["canceled", "gray"],
  ["suppressed", "amber"],
  ["not_started", "gray"],
  ["pending", "amber"],
  ["verified", "green"],
  ["enabled", "green"],
  ["disabled", "gray"],
  ["failing", "red"],
  ["active", "green"],
  ["missing", "amber"],
  ["error", "red"],
  ["unset", "gray"],
  ["unknown", "gray"],
  ["manual", "amber"],
]);

// Hollow square = waiting or stopped. Filled = a result.
const HOLLOW = new Set([
  "queued",
  "scheduled",
  "canceled",
  "not_started",
  "pending",
  "disabled",
  "unset",
  "unknown",
  "missing",
]);

export const toneOf = (status: string): Tone => TONE.get(status) ?? "gray";

export function Badge({
  status,
  label,
  tone,
  hollow,
}: {
  status: string;
  label?: string;
  tone?: Tone;
  hollow?: boolean;
}) {
  const t = tone ?? toneOf(status);
  const empty = hollow ?? HOLLOW.has(status);

  return (
    <span
      className="inline-flex h-[22px] items-center gap-1.5 px-2 font-mono text-[12px] font-medium whitespace-nowrap"
      style={{
        background: `color-mix(in oklab, var(--${t}) 13%, transparent)`,
        color: `var(--${t})`,
      }}
    >
      <span
        className="size-1.5"
        style={{
          background: empty ? "transparent" : "currentColor",
          boxShadow: "inset 0 0 0 1.5px currentColor",
        }}
      />
      {label ?? status}
    </span>
  );
}

// A small square in a status color, for timelines and legends.
export function Dot({ status, size = 10 }: { status: string; size?: number }) {
  const t = toneOf(status);

  return (
    <span
      className="inline-block shrink-0"
      style={{
        width: size,
        height: size,
        background: HOLLOW.has(status) ? "transparent" : `var(--${t})`,
        boxShadow: `inset 0 0 0 1.5px var(--${t})`,
      }}
    />
  );
}

// Forms

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[13px] text-fg2">{label}</span>
      {children}
      {error ? (
        <span className="fs-enter flex items-center gap-1 text-[12.5px] text-red">
          <Icon name="alert" size={16} />
          {error}
        </span>
      ) : (
        hint && <span className="text-[12.5px] text-fg3">{hint}</span>
      )}
    </label>
  );
}

const inputClass = (invalid?: boolean) =>
  cx(
    "h-9 w-full min-w-0 border bg-panel px-2.5 font-mono text-[12.5px] text-fg placeholder:text-fg3 outline-none",
    "focus:border-accent-fg focus:shadow-[0_0_0_2px_color-mix(in_oklab,var(--accent)_30%,transparent)]",
    invalid ? "border-red" : "border-line2",
  );

export function Input({
  invalid,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cx(inputClass(invalid), className)}
      {...rest}
    />
  );
}

export function Textarea({
  invalid,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cx(inputClass(invalid), "h-auto py-2 leading-5", className)}
      {...rest}
    />
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
}

// A dropdown in the style of the dashboard, in place of a native
// <select>. The list grows from the trigger. Arrow keys, Home, End, Enter
// and Escape work as in a native select. With `bare`, the trigger takes
// only `className` (for the dashed filters on the email list).
export function Select({
  value,
  options,
  onChange,
  placeholder,
  display,
  disabled,
  invalid,
  bare,
  chevron = true,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  placeholder?: ReactNode;
  // The trigger content. The default is the label of the value.
  display?: ReactNode;
  disabled?: boolean;
  invalid?: boolean;
  bare?: boolean;
  chevron?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = usePresence(open);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  useDismiss(box, open, () => setOpen(false));
  const current = options.find((o) => o.value === value);

  const show = () => {
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  };

  const pick = (v: string) => {
    setOpen(false);
    trigger.current?.focus();

    if (v !== value) onChange(v);
  };

  const move = (i: number) => {
    const next = Math.min(Math.max(i, 0), options.length - 1);
    setActive(next);
    document
      .getElementById(`${listId}-${next}`)
      ?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div
      ref={box}
      className={cx("relative min-w-0", !bare && "w-full")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          // Keep an open dialog open: only the list closes.
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={(e) => {
          if (e.relatedTarget && !box.current?.contains(e.relatedTarget))
            setOpen(false);
        }}
        onKeyDown={(e) => {
          const keys = ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "];

          if (!keys.includes(e.key)) return;
          e.preventDefault();

          if (!open) return show();

          if (e.key === "ArrowDown") move(active + 1);
          else if (e.key === "ArrowUp") move(active - 1);
          else if (e.key === "Home") move(0);
          else if (e.key === "End") move(options.length - 1);
          else if (options[active]) pick(options[active].value);
        }}
        className={
          bare
            ? className
            : cx(
                inputClass(invalid),
                "flex items-center justify-between gap-2 pr-1.5 text-left disabled:text-fg3",
                className,
              )
        }
      >
        <span className="flex min-w-0 items-center gap-1 truncate">
          {display ?? current?.label ?? (
            <span className="text-fg3">{placeholder}</span>
          )}
        </span>
        {chevron && (
          <Icon
            name="chevron-down"
            size={16}
            className={cx(
              "text-fg3 transition-[rotate] duration-200 ease-out",
              open && "rotate-180",
            )}
          />
        )}
      </button>
      {shown && (
        <div
          id={listId}
          role="listbox"
          data-state={open ? "open" : "closed"}
          // A click in a <label> (a Field) would click the trigger again.
          onClick={(e) => e.preventDefault()}
          className="fs-pop absolute top-full left-0 z-30 mt-1 max-h-64 w-max max-w-[min(360px,calc(100vw-32px))] min-w-full origin-top-left overflow-y-auto border border-line2 bg-bg py-1 shadow-[0_10px_30px_var(--shadow)]"
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
              className={cx(
                "flex cursor-pointer items-center gap-2 py-1.5 pr-2 pl-2.5 font-mono text-[12.5px]",
                i === active &&
                  "bg-raised shadow-[inset_3px_0_0_var(--accent)]",
                o.value === value ? "text-fg" : "text-fg2",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.value === value && (
                <Icon name="check" size={16} className="text-accent-fg" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: ReactNode;
  disabled?: boolean;
}) {
  // The glyph animates only after a change, not when the page loads.
  const [touched, setTouched] = useState(false);

  return (
    <label
      className={cx(
        "inline-flex cursor-pointer items-center gap-1.5 transition-colors",
        !checked && "text-fg2",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          setTouched(true);
          onChange(e.target.checked);
        }}
      />
      {/* In pixelarticons 1.8, "checkbox" has the check mark and
          "checkbox-on" is the empty box. */}
      <Icon
        key={String(checked)}
        name={checked ? "checkbox" : "checkbox-on"}
        className={cx(
          checked && "text-accent-fg",
          touched && "fs-swap",
          "peer-focus-visible:outline-2 peer-focus-visible:outline-accent-fg",
        )}
      />
      {children}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const [touched, setTouched] = useState(false);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        setTouched(true);
        onChange(!checked);
      }}
      className={cx(
        "inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-left",
        checked ? "text-fg" : "text-fg2",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <Icon
        key={String(checked)}
        name={checked ? "toggle-right" : "toggle-left"}
        className={cx(checked && "text-accent-fg", touched && "fs-swap")}
      />
      {children}
    </button>
  );
}

// The bar under the current tab, or the fill behind the current option.
// It slides from the old choice to the new one. The container is
// `relative` and has an <Indicator /> as a direct child. The current item
// is the direct child with aria-selected, aria-current or aria-checked.

const CURRENT =
  ':scope > :is([aria-selected="true"], [aria-current="page"], [aria-current="step"], [aria-checked="true"])';

// Moves the bar of `box` to its current item. Hides it when no item is
// current.
function placeIndicator(box: HTMLElement) {
  const bar = box.querySelector<HTMLElement>(":scope > [data-indicator]");

  if (!bar) return;
  const el = box.querySelector<HTMLElement>(CURRENT);

  if (!el) {
    bar.style.opacity = "0";

    return;
  }

  bar.style.opacity = "1";
  // Fractional sizes, and a bar as wide as the box: with a 1 px bar and
  // integer offsets, a browser zoom snaps the base and the scale grows the
  // error.
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const x = r.left - b.left - box.clientLeft + box.scrollLeft;
  bar.style.transform = `translateX(${x}px) scaleX(${r.width / Number.parseFloat(getComputedStyle(bar).width)})`;
}

export function useIndicator<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  // The first placement does not slide. A label can change its width (a
  // count, a web font that loads), so the bar follows each resize.
  useLayoutEffect(() => {
    const box = ref.current;

    if (!box) return;
    placeIndicator(box);

    const frame = requestAnimationFrame(() => {
      const bar = box.querySelector<HTMLElement>(":scope > [data-indicator]");

      if (bar) bar.dataset.ready = "";
    });

    const watch = new ResizeObserver(() => placeIndicator(box));
    watch.observe(box);

    for (const child of box.children) watch.observe(child);

    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
    };
  }, []);

  // A render can change the current item. The measure is cheap.
  useLayoutEffect(() => {
    if (ref.current) placeIndicator(ref.current);
  });

  return ref;
}

export function Indicator({ fill }: { fill?: boolean }) {
  return (
    <span
      aria-hidden
      data-indicator
      className={cx(
        "pointer-events-none absolute left-0 w-full origin-left opacity-0",
        fill ? "inset-y-0 bg-raised" : "bottom-0 h-0.5 bg-accent",
      )}
    />
  );
}

// The keys of a group with a roving tabindex: the arrow keys, Home and End
// move the focus to another item of that role and select it. Set
// tabIndex 0 on the selected item and -1 on the others.
export function rovingKeys(
  role: "tab" | "radio",
  select: (index: number) => void,
) {
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    const items = [
      ...e.currentTarget.querySelectorAll<HTMLElement>(`[role="${role}"]`),
    ];

    const at = items.findIndex((el) => el === document.activeElement);
    const last = items.length - 1;
    let next = -1;

    if (at < 0) return;

    if (e.key === "ArrowRight" || e.key === "ArrowDown")
      next = at === last ? 0 : at + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = at === 0 ? last : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;

    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
    select(next);
  };
}

// The ids that tie a tab to its panel. A tab gets aria-controls, and the
// panel gets role tabpanel and aria-labelledby.
export function tabIds(id: string, value: string) {
  return { tab: `${id}-tab-${value}`, panel: `${id}-panel` };
}

export function tabPanelProps(id: string, value: string) {
  return {
    role: "tabpanel",
    id: tabIds(id, value).panel,
    "aria-labelledby": tabIds(id, value).tab,
  } as const;
}

// A row of options, one of them selected. For periods and tabs.
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const ref = useIndicator<HTMLDivElement>();

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={rovingKeys("radio", (i) => {
        const o = options[i];

        if (o) onChange(o.value);
      })}
      className="relative flex"
    >
      <Indicator fill />
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
          className={cx(
            "relative h-8 border border-line2 bg-transparent px-2.5 font-mono text-[12px]",
            i > 0 && "-ml-px",
            o.value === value ? "z-10 text-fg" : "text-fg3 hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Tabs under a page header, with the lime bar under the current tab.
// With `id`, each tab has an id and aria-controls. Give the panel
// tabPanelProps(id, value).
export function Tabs<T extends string>({
  id,
  value,
  tabs,
  onChange,
  className,
}: {
  id?: string;
  value: T;
  tabs: { value: T; label: ReactNode; count?: number }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const ref = useIndicator<HTMLDivElement>();

  return (
    <div
      ref={ref}
      role="tablist"
      onKeyDown={rovingKeys("tab", (i) => {
        const t = tabs[i];

        if (t) onChange(t.value);
      })}
      className={cx(
        "relative flex items-stretch border-b border-line",
        className,
      )}
    >
      <Indicator />
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          id={id ? tabIds(id, t.value).tab : undefined}
          aria-controls={id ? tabIds(id, t.value).panel : undefined}
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
          className={cx(
            "flex h-10 items-center gap-1.5 border-0 bg-transparent px-3.5 font-mono text-[12.5px] font-medium",
            t.value === value ? "text-fg" : "text-fg3 hover:text-fg",
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="text-fg3">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// Copy

// Writes text to the clipboard. The button turns into a green check for
// 1.5 s. A live region tells screen readers.
export function useCopy(): [boolean, (text: string) => void] {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback((text: string) => {
    const run = async () => {
      await navigator.clipboard.writeText(text);
      setDone(true);
      announce("Copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1500);
    };

    void run();
  }, []);

  return [done, copy];
}

export function CopyButton({
  text,
  label = "Copy",
  size = 32,
  bordered = false,
  className,
}: {
  text: string;
  label?: string;
  size?: 32 | 40 | 44;
  bordered?: boolean;
  className?: string;
}) {
  const [done, copy] = useCopy();
  // The swap animates only after a copy, not when the page loads.
  const [used, setUsed] = useState(false);

  if (done)
    return (
      <span
        className={cx(
          "fs-enter inline-flex shrink-0 items-center gap-1.5 px-2 font-mono text-[12px] text-green",
          className,
        )}
        // No fill: a tint box floats with uneven gaps in a padded field.
        style={{ height: size }}
      >
        <Icon name="check" size={16} className="fs-swap" />
        copied
      </span>
    );

  return (
    <IconButton
      icon="copy"
      label={label}
      size={size}
      bordered={bordered}
      className={cx(used && "fs-fade", className)}
      onClick={(e) => {
        e.stopPropagation();
        setUsed(true);
        copy(text);
      }}
    />
  );
}

// A mono value with a copy button after it.
export function CopyValue({
  value,
  display,
  className,
}: {
  value: string;
  display?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex min-w-0 items-center gap-1.5 font-mono text-[12.5px]",
        className,
      )}
    >
      <span className="min-w-0 truncate">{display ?? value}</span>
      <CopyButton text={value} />
    </span>
  );
}

// Relative time with the exact UTC time on hover and focus.
export function RelTime({
  at,
  className,
}: {
  at: string | null | undefined;
  className?: string;
}) {
  const now = useNow();

  if (!at) return <span className={cx("text-fg3", className)}>-</span>;
  const exact = utc(at);

  return (
    <time
      dateTime={at}
      tabIndex={0}
      title={exact}
      aria-label={`${relative(at, now)}, ${exact}`}
      className={cx(
        "group relative font-mono text-[12px] whitespace-nowrap underline decoration-fg3 decoration-dotted underline-offset-3",
        className,
      )}
    >
      {relative(at, now)}
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-0 z-30 mb-1.5 translate-y-0.5 bg-fg px-2 py-1 text-[12.5px] whitespace-nowrap text-bg no-underline opacity-0 transition-[opacity,translate,visibility] duration-150 ease-out group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-hover:delay-200 group-focus:visible group-focus:translate-y-0 group-focus:opacity-100"
      >
        {exact}
      </span>
    </time>
  );
}

// Toasts and screen reader announcements

// Only a plain text message goes to the screen reader announcer.
function isText(message: ReactNode): message is string {
  return typeof message === "string";
}

interface Toast {
  id: number;
  // True while the toast plays its exit.
  closing?: boolean;
  tone: "success" | "error" | "info";
  message: ReactNode;
  action?: { label: string; href?: string; onClick?: () => void };
}

type ToastInput = Omit<Toast, "id">;

const ToastContext = createContext<(t: ToastInput) => void>(() => {});

let announcer: ((m: string) => void) | null = null;

export function announce(message: string) {
  announcer?.(message);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [live, setLive] = useState("");
  const next = useRef(1);

  // The toast goes out to the right edge, then leaves the list.
  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.map((x) => (x.id === id ? { ...x, closing: true } : x)));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), EXIT_MS);
  }, []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = next.current++;
      setToasts((list) => [...list.slice(-3), { ...t, id }]);

      if (isText(t.message)) setLive(t.message);
      setTimeout(() => dismiss(id), t.tone === "error" ? 8000 : 4000);
    },
    [dismiss],
  );

  useEffect(() => {
    announcer = (m) => {
      setLive("");
      requestAnimationFrame(() => setLive(m));
    };

    return () => {
      announcer = null;
    };
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* A portal in the body, outside the app. A modal panel makes the app
          inert, and the toasts must stay active. */}
      {createPortal(
        <div
          data-inert-skip
          className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2"
        >
          <div aria-live="polite" className="sr-only">
            {live}
          </div>
          {toasts.map((t) => (
            <div
              key={t.id}
              data-state={t.closing ? "closed" : "open"}
              className={cx(
                "fs-toast pointer-events-auto flex items-center gap-2 border bg-raised py-2 pr-2 pl-2.5 shadow-[0_10px_30px_var(--shadow)]",
                t.tone === "error" ? "border-red" : "border-line2",
              )}
            >
              <Icon
                name={
                  t.tone === "error"
                    ? "alert"
                    : t.tone === "success"
                      ? "check"
                      : "info-box"
                }
                className={
                  t.tone === "error"
                    ? "text-red"
                    : t.tone === "success"
                      ? "text-green"
                      : "text-blue"
                }
              />
              <span className="flex-1">{t.message}</span>
              {t.action &&
                (t.action.href ? (
                  <Link
                    href={t.action.href}
                    className="font-mono text-[12px]"
                    onClick={() => dismiss(t.id)}
                  >
                    {t.action.label}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="border-0 bg-transparent font-mono text-[12px] text-fg underline"
                    onClick={() => {
                      t.action?.onClick?.();
                      dismiss(t.id);
                    }}
                  >
                    {t.action.label}
                  </button>
                ))}
              <IconButton
                icon="close"
                label="Dismiss"
                onClick={() => dismiss(t.id)}
              />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// The message of an error, for a toast or a form.
export function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;

  return String(cause);
}

// Dialogs

// A modal dialog. With `locked`, a click outside and Escape do not close
// it: a one-time secret must be copied or confirmed first.
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  locked,
  width = 440,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  locked?: boolean;
  width?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // The content stays while the dialog plays its exit.
  const shown = usePresence(open);
  useEffect(() => {
    const d = ref.current;

    if (!d) return;

    if (open && !d.open) d.showModal();

    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();

        if (!locked) onClose();
      }}
      onClick={(e) => {
        if (!locked && e.target === ref.current) onClose();
      }}
      className="fs-dialog m-auto max-h-[calc(100vh-32px)] w-[calc(100vw-32px)] border border-line2 bg-bg p-0 text-fg shadow-[0_20px_50px_var(--shadow)]"
      style={{ maxWidth: width }}
    >
      {shown && (
        <>
          <div
            id={titleId}
            className="px-5 pt-5 pb-1.5 text-[16px] font-semibold"
          >
            {title}
          </div>
          <div className="px-5 pb-5 text-[13.5px] text-fg2">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line p-5">
              {footer}
            </div>
          )}
        </>
      )}
    </dialog>
  );
}

// The action row at the bottom of a dialog. Use it in the children of a
// Dialog when the actions need the state of the dialog body.
export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-5 -mb-5 mt-5 flex flex-wrap justify-end gap-2 border-t border-line p-5">
      {children}
    </div>
  );
}

interface ConfirmProps {
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
  body: ReactNode;
  action: string;
  confirmText?: string;
  danger?: boolean;
}

// A confirm dialog. With `confirmText`, the owner types the text first.
export function ConfirmDialog({
  open,
  title,
  ...rest
}: ConfirmProps & { open: boolean; title: ReactNode }) {
  return (
    <Dialog open={open} onClose={rest.onClose} title={title} width={400}>
      {/* The body mounts on open, so each open starts empty. */}
      <ConfirmBody {...rest} />
    </Dialog>
  );
}

function ConfirmBody({
  onClose,
  onConfirm,
  body,
  action,
  confirmText,
  danger = true,
}: ConfirmProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !confirmText || typed === confirmText;

  const run = async () => {
    setBusy(true);
    setError(null);

    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3.5">
      <p className="m-0">{body}</p>
      {confirmText && (
        <Field
          label={
            <>
              Type <code className="text-fg">{confirmText}</code> to confirm
            </>
          }
        >
          <Input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) void run();
            }}
          />
        </Field>
      )}
      {error && <Notice tone="red">{error}</Notice>}
      <DialogFooter>
        <Button onClick={onClose}>cancel</Button>
        <Button
          variant={danger ? "danger-solid" : "primary"}
          disabled={!ready}
          busy={busy}
          onClick={run}
        >
          {action}
        </Button>
      </DialogFooter>
    </div>
  );
}

// The elements that can take focus, for the Tab trap of a panel.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A panel that slides in from the right, for detail views. It is a modal:
// focus moves into it, Tab stays inside, Escape closes it, the page
// behind it is inert, and focus goes back to the opener on close. The
// panel is a portal in the body, so the other children of the body can
// be inert. An element with data-inert-skip stays active (the toasts).
export function SidePanel({
  open,
  onClose,
  title,
  children,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: number;
}) {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const shown = usePresence(open, 260);

  // While the panel is closed, remember the last focused element. That
  // is the opener when the panel opens.
  useEffect(() => {
    if (open) return;

    const remember = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement) opener.current = e.target;
    };

    document.addEventListener("focusin", remember);

    return () => document.removeEventListener("focusin", remember);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const inerted: HTMLElement[] = [];

    for (const el of document.body.children) {
      if (
        el instanceof HTMLElement &&
        el !== root.current &&
        !el.inert &&
        !el.hasAttribute("data-inert-skip")
      ) {
        el.inert = true;
        inerted.push(el);
      }
    }

    const p = panel.current;

    // A field with autoFocus keeps the focus.
    if (p && !p.contains(document.activeElement)) p.focus();

    const back = opener.current;

    return () => {
      for (const el of inerted) el.inert = false;

      if (back?.isConnected) back.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const fn = (e: KeyboardEvent) => {
      // A dialog in the panel handles its own Escape.
      const inner =
        e.target instanceof Element && e.target.closest("dialog[open]");

      if (e.key === "Escape" && !e.defaultPrevented && !inner) onClose();
    };

    window.addEventListener("keydown", fn);

    return () => window.removeEventListener("keydown", fn);
  }, [open, onClose]);

  if (!shown) return null;

  const trap = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);

    if (!first || !last) {
      e.preventDefault();

      return;
    }

    const at = document.activeElement;

    if (e.shiftKey && (at === first || at === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      ref={root}
      data-state={open ? "open" : "closed"}
      inert={!open}
      className="fs-sheet fixed inset-0 z-40 flex justify-end"
    >
      <button
        type="button"
        aria-label="Close panel"
        tabIndex={-1}
        className="fs-scrim absolute inset-0 border-0 bg-black/40"
        onClick={onClose}
      />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trap}
        className="fs-panel relative flex h-full w-full flex-col overflow-hidden border-l border-line2 bg-bg shadow-[0_20px_50px_var(--shadow)] outline-none"
        style={{ maxWidth: width }}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line pr-2 pl-5">
          <div
            id={titleId}
            className="min-w-0 truncate text-[15px] font-semibold"
          >
            {title}
          </div>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

// Secrets

// A one-time secret, with an amber border.
export function SecretReveal({
  secret,
  title = "You will not see this again",
}: {
  secret: string;
  title?: string;
}) {
  const [done, copy] = useCopy();

  return (
    <div className="border border-amber">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-amber">
        <Icon name="warning-box" />
        <span className="font-semibold text-fg">{title}</span>
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <code className="flex-1 font-mono text-[12.5px] [overflow-wrap:anywhere] text-fg">
          {secret}
        </code>
        <Button
          variant={done ? "secondary" : "primary"}
          size="sm"
          icon={done ? "check" : "copy"}
          onClick={() => copy(secret)}
          className={done ? "text-green" : undefined}
        >
          {done ? "copied" : "copy"}
        </Button>
      </div>
    </div>
  );
}

// A stored secret, masked until the owner reveals it.
export function MaskedSecret({
  secret,
  onRotate,
}: {
  secret: string;
  onRotate?: () => void;
}) {
  const [shown, setShown] = useState(false);
  const masked = `${secret.slice(0, 6)}${"•".repeat(12)}${secret.slice(-3)}`;

  return (
    <div className="flex h-10 items-center gap-1.5 border border-line pr-1 pl-3">
      <code
        key={String(shown)}
        className="fs-fade min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg2 transition-opacity"
      >
        {shown ? secret : masked}
      </code>
      <IconButton
        icon={shown ? "eye-closed" : "eye"}
        label={shown ? "Hide" : "Reveal"}
        onClick={() => setShown(!shown)}
      />
      <CopyButton text={secret} />
      {onRotate && (
        <IconButton icon="reload" label="Rotate" onClick={onRotate} />
      )}
    </div>
  );
}

// Code

export interface CodeTab {
  label: string;
  code: string;
}

export function CodeBlock({
  tabs,
  className,
}: {
  tabs: CodeTab[];
  className?: string;
}) {
  const [i, setI] = useState(0);
  const tab = tabs[Math.min(i, tabs.length - 1)]!;
  const bar = useIndicator<HTMLDivElement>();
  const id = useId();

  return (
    <div className={cx("min-w-0 border border-line bg-panel", className)}>
      <div className="flex items-stretch border-b border-line">
        <div
          ref={bar}
          role="tablist"
          onKeyDown={rovingKeys("tab", setI)}
          className="relative flex min-w-0 overflow-x-auto"
        >
          <Indicator />
          {tabs.map((t, n) => (
            <button
              key={t.label}
              type="button"
              role="tab"
              id={tabIds(id, String(n)).tab}
              aria-controls={tabIds(id, String(n)).panel}
              aria-selected={n === i}
              tabIndex={n === i ? 0 : -1}
              onClick={() => setI(n)}
              className={cx(
                "h-10 shrink-0 border-0 bg-transparent px-3.5 font-mono text-[12.5px] font-medium",
                n === i ? "text-fg" : "text-fg3 hover:text-fg",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <div className="grid place-items-center border-l border-line">
          <CopyButton text={tab.code} label="Copy code" size={40} />
        </div>
      </div>
      <pre
        key={tab.label}
        {...tabPanelProps(id, String(Math.min(i, tabs.length - 1)))}
        tabIndex={0}
        className="fs-fade m-0 overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-5 transition-opacity"
      >
        <Highlight code={tab.code} />
      </pre>
    </div>
  );
}

// A small highlighter: comments are muted, strings are green, keywords
// are lime. Enough for the short snippets in the dashboard.

function Highlight({ code }: { code: string }) {
  const parts: ReactNode[] = [];

  const re =
    /(\/\/[^\n]*|#[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`]*`)|\b(const|let|await|async|new|import|from|export|return|function|curl|if|else|true|false|null)\b/g;

  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = re.exec(code))) {
    if (m.index > last) parts.push(code.slice(last, m.index));
    const [text, comment, str] = m;

    const color = comment
      ? "var(--fg3)"
      : str
        ? "var(--green)"
        : "var(--accent-fg)";

    parts.push(
      <span key={k++} style={{ color }}>
        {text}
      </span>,
    );
    last = m.index + text.length;
  }

  parts.push(code.slice(last));

  return <>{parts}</>;
}

// Page structure

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 px-4 pt-6 pb-4 md:px-8 md:pt-7">
      {back && (
        <TextLink
          href={back.href}
          icon="chevron-left"
          className="self-start font-mono text-[12.5px] text-fg2"
        >
          {back.label}
        </TextLink>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="m-0 text-[26px] leading-8 font-semibold tracking-[-0.02em] [overflow-wrap:anywhere]">
            {title}
          </h1>
          {subtitle && <div className="text-fg2">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export function SectionTitle({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-wrap items-end justify-between gap-2",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="m-0 text-[15px] leading-[21px] font-semibold">
          {title}
        </h2>
        {subtitle && <span className="text-[13px] text-fg2">{subtitle}</span>}
      </div>
      {actions}
    </div>
  );
}

// A boxed message: a hint, a warning or an error.
export function Notice({
  tone = "blue",
  icon,
  title,
  children,
  action,
  className,
}: {
  tone?: Tone | "accent";
  icon?: string;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const color = tone === "accent" ? "var(--accent-fg)" : `var(--${tone})`;

  const glyph =
    icon ??
    (tone === "red"
      ? "alert"
      : tone === "amber"
        ? "warning-box"
        : tone === "green"
          ? "check"
          : "info-box");

  return (
    <div
      role={tone === "red" ? "alert" : undefined}
      className={cx(
        "fs-enter flex items-start gap-2.5 border px-3 py-2.5",
        className,
      )}
      style={{
        borderColor: `color-mix(in oklab, ${color} 45%, var(--line))`,
        background: `color-mix(in oklab, ${color} 6%, transparent)`,
      }}
    >
      <span style={{ color }} className="pt-px">
        <Icon name={glyph} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && <span className="font-semibold text-fg">{title}</span>}
        {children && <div className="text-fg2">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

// Empty, loading and error states

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon: string;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "fs-enter flex flex-col items-start gap-2 px-4 py-10 md:px-8",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <Icon name={icon} className="text-fg3" />
        <span className="text-[18px] font-semibold">{title}</span>
      </div>
      {children && <div className="max-w-[560px] text-fg2">{children}</div>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  title = "Could not load this list",
  onRetry,
  className,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const e = error instanceof ApiRequestError ? error : null;
  const detail = e ? [e.status, e.code].filter(Boolean).join(" · ") : null;
  const offline = error instanceof TypeError;

  return (
    <div
      className={cx(
        "fs-enter flex flex-col items-start gap-2 px-4 py-10 md:px-8",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <Icon name="cloud" className="text-red" />
        <span className="text-[18px] font-semibold">{title}</span>
      </div>
      <span className="max-w-[560px] text-fg2">
        {offline
          ? "The dashboard cannot reach the Worker. Check your connection."
          : e && e.status >= 500
            ? "The Worker could not read the database. This is usually brief."
            : errorText(error)}
      </span>
      {detail && (
        <code className="font-mono text-[12px] text-fg3">{detail}</code>
      )}
      {onRetry && (
        <Button icon="reload" onClick={onRetry} className="mt-1.5">
          retry
        </Button>
      )}
    </div>
  );
}

// Skeleton rows that copy the shape of a real row.
export function Skeleton({
  rows = 6,
  widths = ["70%", "55%", "80%", "45%", "62%", "50%"],
  className,
}: {
  rows?: number;
  widths?: string[];
  className?: string;
}) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading"
      className={cx("flex flex-col", className)}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex h-[52px] items-center gap-3 border-b border-line px-4 md:px-8"
        >
          <span
            className="h-2.5 animate-pulse bg-raised"
            style={{ width: widths[i % widths.length] }}
          />
          <span className="ml-auto h-[22px] w-[70px] animate-pulse bg-raised" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonBlock({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={cx("block animate-pulse bg-raised", className)}
      style={style}
    />
  );
}

// Tables

// A row sets its columns in the CSS variable --cols. The class
// md:[grid-template-columns:var(--cols)] reads it.
declare module "react" {
  interface CSSProperties {
    "--cols"?: string;
    // The place of an item in a staggered entry (see .fs-grow).
    "--i"?: number;
  }
}

// A table on a CSS grid. On a narrow screen each row stacks, and the
// header row hides. The grid has no ARIA table roles: the cells are free
// content, and the header is hidden on a narrow screen. A row that opens
// something has a real link or button that covers the row.
export function TableHead({
  columns,
  template,
  className,
}: {
  columns: ReactNode[];
  template: string;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "hidden h-9 items-center gap-4 border-y border-line px-4 font-mono text-[12px] text-fg3 md:grid md:px-8",
        className,
      )}
      style={{ gridTemplateColumns: template }}
    >
      {columns.map((c, i) => (
        <span key={i} className="flex items-center">
          {c}
        </span>
      ))}
    </div>
  );
}

export function TableRow({
  template,
  href,
  onOpen,
  children,
  danger,
  muted,
  className,
}: {
  template: string;
  href?: string;
  onOpen?: () => void;
  children: ReactNode;
  danger?: boolean;
  muted?: boolean;
  className?: string;
}) {
  const id = useId();
  const clickable = Boolean(href || onOpen);

  // The cover has no text. It takes its name from the text of the row.
  const cover = "fs-row-cover absolute inset-0 border-0 bg-transparent p-0";

  return (
    <div
      id={id}
      className={cx(
        "fs-row fs-fade relative grid grid-cols-1 gap-x-4 gap-y-1 border-b border-line px-4 py-3 md:items-center md:px-8 md:py-2 md:[grid-template-columns:var(--cols)]",
        clickable &&
          "cursor-pointer hover:bg-hover hover:shadow-[inset_3px_0_0_var(--accent)] has-[.fs-row-cover:focus-visible]:bg-hover has-[.fs-row-cover:focus-visible]:shadow-[inset_3px_0_0_var(--accent)]",
        danger && "shadow-[inset_3px_0_0_var(--red)]",
        muted && "text-fg3",
        className,
      )}
      style={{ "--cols": template }}
    >
      {href ? (
        <Link href={href} aria-labelledby={id} className={cover} />
      ) : onOpen ? (
        <button
          type="button"
          aria-labelledby={id}
          onClick={onOpen}
          className={cover}
        />
      ) : null}
      {children}
    </div>
  );
}

// Previous and next pages with Resend's cursors. With `full`, a narrow
// screen hides the note and makes the buttons tall and full width.
export function Pager({
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  note,
  full,
}: {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  note?: ReactNode;
  full?: boolean;
}) {
  if (!hasPrev && !hasNext && !note) return null;

  const wide = full && "max-md:h-11 max-md:flex-1 max-md:justify-center";

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-[12.5px] text-fg3 md:px-8">
      <span className={cx(full && "max-md:hidden")}>{note}</span>
      <span className={cx("flex gap-1.5", full && "max-md:w-full")}>
        <Button
          size="sm"
          icon="chevron-left"
          disabled={!hasPrev}
          onClick={onPrev}
          className={cx(wide)}
        >
          previous
        </Button>
        <Button
          size="sm"
          iconEnd="chevron-right"
          disabled={!hasNext}
          onClick={onNext}
          className={cx(wide)}
        >
          next
        </Button>
      </span>
    </div>
  );
}

// A filter that is set, with a close button to clear it.
export function FilterChip({
  name,
  value,
  onClear,
}: {
  name: string;
  value: ReactNode;
  onClear: () => void;
}) {
  return (
    <span className="fs-pop flex h-11 origin-left items-center gap-1 border border-line2 bg-raised pl-2 font-mono text-[12px] md:h-9">
      <span className="text-fg3">{name}</span> {value}
      <IconButton icon="close" label={`Clear ${name}`} onClick={onClear} />
    </span>
  );
}

// Key and value rows, for the side column of a detail page.
export function Meta({
  rows,
  className,
}: {
  rows: [ReactNode, ReactNode][];
  className?: string;
}) {
  return (
    <dl className={cx("m-0 flex flex-col", className)}>
      {rows.map(([k, v], i) => (
        <div
          key={i}
          className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 border-b border-line py-2 last:border-b-0"
        >
          <dt className="text-[13px] text-fg3">{k}</dt>
          <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// A small keyboard hint.
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex items-center border border-line2 px-1 font-mono text-[11px] text-fg2">
      {children}
    </kbd>
  );
}
