const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const encoder = new TextEncoder();

export function randomBase62(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let n = 0n;

  for (const b of buf) n = (n << 8n) | BigInt(b);
  let out = "";

  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }

  return out;
}

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(bin);
}

export function fromBase64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);

  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmac(
  secret: string | Uint8Array,
  value: string,
): Promise<Uint8Array> {
  const key = await hmacKey(
    secret instanceof Uint8Array ? secret : encoder.encode(secret),
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
}

// Compares two strings in constant time for strings of equal length.
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);

  if (x.length !== y.length) return false;
  let diff = 0;

  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;

  return diff === 0;
}

// PBKDF2 with SHA-256. workerd allows at most 100000 iterations.
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      256,
    ),
  );
}

// Returns "pbkdf2$<iterations>$<salt>$<hash>", with base64url parts.
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);

  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");

  if (scheme !== "pbkdf2" || !iterations || !salt || !hash) return false;
  const n = Number(iterations);

  if (!Number.isInteger(n) || n < 1 || n > PBKDF2_ITERATIONS) return false;
  const saltBytes = fromBase64(salt.replaceAll("-", "+").replaceAll("_", "/"));

  return safeEqual(toBase64Url(await pbkdf2(password, saltBytes, n)), hash);
}
