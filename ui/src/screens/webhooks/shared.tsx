import {
  Button,
  Checkbox,
  Dialog,
  DialogFooter,
  Field,
  Input,
  Notice,
  SecretReveal,
} from "../../components/ui";

// The parts that the webhook list and the webhook detail share.

// "email.bounced" shows as "bounced".
export const shortEvent = (e: string) => e.replace(/^email\./, "");

// The result of a check of the endpoint URL. An error blocks the form.
// A warning does not, because the Worker accepts http.
interface EndpointCheck {
  error?: string;
  warning?: string;
}

export function checkEndpoint(value: string): EndpointCheck {
  const v = value.trim();

  if (!v) return {};
  let url: URL;

  try {
    url = new URL(v);
  } catch {
    return {
      error: "Enter a full URL, for example https://api.example.com/hooks.",
    };
  }

  if (url.protocol === "http:")
    return {
      warning: "Use https. Webhooks are signed but not encrypted over http.",
    };

  if (url.protocol !== "https:")
    return {
      error:
        "Use an https URL. Webhooks are signed but not encrypted over http.",
    };

  return {};
}

const GROUPS: [string, string[]][] = [
  ["Sending", ["scheduled", "sent", "failed", "suppressed"]],
  ["Delivery", ["delivered", "delivery_delayed", "bounced", "complained"]],
  ["Engagement", ["opened", "clicked"]],
];

// A list of events with a checkbox each, in groups. The Worker gives the
// full list of events.
export function EventPicker({
  all,
  value,
  onChange,
}: {
  all: string[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const known = new Set(GROUPS.flatMap(([, items]) => items));

  // A group with no events stays out.
  const groups = GROUPS.flatMap(([name, items]) => {
    const events = all.filter((e) => items.includes(shortEvent(e)));

    return events.length ? [{ name, events }] : [];
  });

  const other = all.filter((e) => !known.has(shortEvent(e)));

  if (other.length) groups.push({ name: "Other", events: other });

  const toggle = (e: string, on: boolean) =>
    onChange(on ? [...value, e] : value.filter((x) => x !== e));

  return (
    <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
      <legend className="sr-only">Events</legend>
      <div className="flex min-h-10 items-center border-y border-line font-semibold text-fg">
        <Checkbox
          checked={all.length > 0 && value.length === all.length}
          onChange={(on) => onChange(on ? [...all] : [])}
        >
          All events
        </Checkbox>
      </div>
      {groups.map((g) => (
        <div
          key={g.name}
          className="grid grid-cols-1 gap-x-2 border-b border-line py-1.5 sm:grid-cols-[110px_minmax(0,1fr)]"
        >
          <span className="text-[13px] leading-6 text-fg2">{g.name}</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12.5px]">
            {g.events.map((e) => (
              <Checkbox
                key={e}
                checked={value.includes(e)}
                onChange={(on) => toggle(e, on)}
              >
                {shortEvent(e)}
              </Checkbox>
            ))}
          </div>
        </div>
      ))}
    </fieldset>
  );
}

// The endpoint URL and the events: the fields of the add form and of the
// edit dialog.
export function EndpointFields({
  all,
  endpoint,
  picked,
  onEndpoint,
  onPicked,
}: {
  all: string[];
  endpoint: string;
  picked: string[];
  onEndpoint: (v: string) => void;
  onPicked: (v: string[]) => void;
}) {
  const check = checkEndpoint(endpoint);

  return (
    <>
      <Field label="Endpoint URL" error={check.error}>
        <Input
          autoFocus
          type="url"
          value={endpoint}
          invalid={Boolean(check.error)}
          placeholder="https://api.example.com/hooks/email"
          onChange={(e) => onEndpoint(e.target.value)}
        />
      </Field>
      {check.warning && (
        <Notice tone="amber" className="-mt-1.5">
          {check.warning}
        </Notice>
      )}
      <EventPicker all={all} value={picked} onChange={onPicked} />
      {picked.length === 0 && (
        <span className="text-[12.5px] text-fg3">Pick at least one event.</span>
      )}
    </>
  );
}

// Shows a signing secret once. The dialog stays open until the owner
// copies the secret or presses "I saved it".
export function SecretDialog({
  secret,
  title,
  onClose,
}: {
  secret: string | null;
  title: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={secret !== null}
      onClose={onClose}
      title={title}
      width={560}
      locked
    >
      {secret && (
        <div className="flex flex-col gap-3">
          <SecretReveal secret={secret} />
          <span className="text-[13px] text-fg2">
            Use this signing secret to check that calls really come from
            fullsend. It signs each call in the{" "}
            <code className="font-mono text-fg">svix-signature</code> header.
            The Svix libraries and{" "}
            <code className="font-mono text-fg">resend.webhooks.verify()</code>{" "}
            check it.
          </span>
          <DialogFooter>
            <Button icon="check" onClick={onClose}>
              I saved it
            </Button>
          </DialogFooter>
        </div>
      )}
    </Dialog>
  );
}
