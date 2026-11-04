import { z } from "zod";
import type { Env } from "../env";
import { VERSION } from "../version";
import { type JsonValue, parseJsonText } from "./json";
import { setSettings } from "./settings";

const PACKAGE_URL =
  "https://raw.githubusercontent.com/omznc/fullsend/main/package.json";

const pkg = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });

function parts(version: string): number[] {
  return version.split(".").map(Number);
}

// True when latest is a newer major.minor.patch than current. An empty or
// invalid latest gives false.
export function isNewer(latest: string, current: string): boolean {
  if (!pkg.shape.version.safeParse(latest).success) return false;

  const a = parts(latest);
  const b = parts(current);

  for (const [i, n] of a.entries()) {
    const m = b[i] ?? 0;

    if (n !== m) return n > m;
  }

  return false;
}

async function fetchPackage(): Promise<JsonValue | null> {
  try {
    const res = await fetch(PACKAGE_URL, {
      headers: { "user-agent": "fullsend" },
      signal: AbortSignal.timeout(10_000),
    });

    return res.ok ? parseJsonText(await res.text()) : null;
  } catch {
    return null;
  }
}

// This request sends no data about the deploy. It runs when telemetry is
// off. A fetch failure keeps the old value, because the check is optional.
export async function checkForUpdate(env: Env): Promise<void> {
  const body = await fetchPackage();

  if (body === null) return;

  const found = pkg.safeParse(body);

  if (found.success)
    await setSettings(env, { latest_version: found.data.version });
}

// The update that the session shows. Only a signed-in caller sees it.
export function updateInfo(
  latest: string,
  signedIn: boolean,
): { latest: string; current: string } | null {
  return signedIn && isNewer(latest, VERSION)
    ? { latest, current: VERSION }
    : null;
}
