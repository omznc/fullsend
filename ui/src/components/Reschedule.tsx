import { useState } from "react";
import { api } from "../api";
import { Button, cx, errorText, Icon, Input, Notice, useToast } from "./ui";

// The reschedule control: a month grid, a time and a free text field. The
// time is always in UTC. The email list and the email detail use it.

const pad = (n: number) => String(n).padStart(2, "0");

const utcMs = (y: number, m: number, d: number, h = 0, min = 0) =>
  Date.UTC(y, m, d, h, min);

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function ReschedulePicker({
  now,
  initial,
  id,
  onDone,
}: {
  now: number;
  initial: string | null;
  id: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const start = new Date(initial ?? now);

  const [view, setView] = useState({
    y: start.getUTCFullYear(),
    m: start.getUTCMonth(),
  });

  const [day, setDay] = useState<{ y: number; m: number; d: number } | null>(
    initial
      ? {
          y: start.getUTCFullYear(),
          m: start.getUTCMonth(),
          d: start.getUTCDate(),
        }
      : null,
  );

  const [time, setTime] = useState(
    initial
      ? `${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())}`
      : "09:00",
  );

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const offset = (new Date(utcMs(view.y, view.m, 1)).getUTCDay() + 6) % 7;
  const count = new Date(utcMs(view.y, view.m + 1, 0)).getUTCDate();

  const cells = Array.from(
    { length: Math.ceil((offset + count) / 7) * 7 },
    (_, i) => i - offset + 1,
  );

  const shift = (by: number) =>
    setView((v) => {
      const d = new Date(Date.UTC(v.y, v.m + by, 1));

      return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    });

  const save = async () => {
    let value = text.trim();

    if (!value) {
      const t = TIME.exec(time.trim());

      if (!day || !t) {
        setError("Pick a day and write the time as HH:MM.");

        return;
      }

      value = new Date(
        Date.UTC(day.y, day.m, day.d, Number(t[1]), Number(t[2])),
      ).toISOString();
    }

    setBusy(true);
    setError(null);

    try {
      await api(`/emails/${id}`, {
        method: "PATCH",
        body: { scheduled_at: value },
      });
      toast({ tone: "success", message: "Email rescheduled." });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const arrow =
    "grid size-8 place-items-center border-0 bg-transparent text-fg2 hover:text-fg max-md:size-11";

  return (
    <div className="text-fg">
      <div className="flex items-center justify-between border-b border-line p-1 font-mono text-[12.5px] font-semibold">
        <button
          type="button"
          aria-label="Previous month"
          className={arrow}
          onClick={() => shift(-1)}
        >
          <Icon name="chevron-left" size={16} />
        </button>
        {MONTH_NAMES[view.m]} {view.y}
        <button
          type="button"
          aria-label="Next month"
          className={arrow}
          onClick={() => shift(1)}
        >
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 p-2 text-center font-mono text-[12px]">
        {cells.map((n, i) => {
          if (n < 1 || n > count) return <span key={i} />;
          const past = utcMs(view.y, view.m, n, 23, 59) < now;
          const on = day?.y === view.y && day.m === view.m && day.d === n;

          return (
            <button
              key={i}
              type="button"
              disabled={past}
              aria-pressed={on}
              onClick={() => setDay({ y: view.y, m: view.m, d: n })}
              className={cx(
                "press h-8 border-0 max-md:h-10",
                on
                  ? "bg-accent font-semibold text-accent-ink"
                  : "bg-transparent text-fg hover:bg-hover",
                past && "text-fg3 hover:bg-transparent",
              )}
            >
              {n}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 border-t border-line p-2">
        <div className="flex items-center gap-1.5">
          <span className="text-fg3">
            <Icon name="clock" />
          </span>
          <Input
            aria-label="Time, UTC"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            placeholder="09:00"
            className="flex-1"
          />
          <span className="font-mono text-[12px] text-fg2">UTC</span>
        </div>
        <Input
          aria-label="Or write the time in words"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="or write it, for example in 1 hour"
        />
        {error && (
          <Notice tone="red" className="text-[13px]">
            {error}
          </Notice>
        )}
        <Button
          variant="primary"
          busy={busy}
          onClick={() => void save()}
          className="self-end max-md:h-11"
        >
          save
        </Button>
      </div>
    </div>
  );
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
