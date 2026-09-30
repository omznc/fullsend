import { hmac, safeEqual, toBase64Url } from "../lib/crypto";

export async function signLink(
  secret: string,
  emailId: string,
  url: string,
): Promise<string> {
  return toBase64Url(await hmac(secret, `${emailId}:${url}`)).slice(0, 22);
}

export async function checkLink(
  secret: string,
  emailId: string,
  url: string,
  sig: string,
): Promise<boolean> {
  return safeEqual(await signLink(secret, emailId, url), sig);
}
