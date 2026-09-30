import { createContext, useContext } from "react";
import type { Session } from "./api";

export interface SessionValue {
  session: Session;
  reload: () => Promise<void>;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionContext);

  if (!v) throw new Error("useSession needs a SessionContext");

  return v;
}

// The public base URL of the API: the custom hostname when it is set,
// otherwise the URL of the Worker.
export function apiBase(s: Session): string {
  return s.api_hostname ? `https://${s.api_hostname}` : s.worker_url;
}
