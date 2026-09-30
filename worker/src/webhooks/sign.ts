import { fromBase64, hmac, randomBase62, toBase64 } from "../lib/crypto";

export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));

  return `whsec_${toBase64(bytes)}`;
}

// Signs a body the Svix way, as Resend does. `resend.webhooks.verify()`
// and the `svix` package check this signature.
export async function sign(
  secret: string,
  messageId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = fromBase64(secret.replace(/^whsec_/, ""));
  const mac = await hmac(key, `${messageId}.${timestamp}.${body}`);

  return `v1,${toBase64(mac)}`;
}

export const randomId = () => randomBase62(16);
