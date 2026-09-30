// Makes an API key without the dashboard. It prints the key and the SQL
// that stores its hash. Run the SQL against the D1 database, for example:
//
//   node scripts/create-key.ts "my app" > key.sql
//   cf d1 execute fullsend --remote --file key.sql
//
// The key shows only here. fullsend stores only its SHA-256 hash.
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function base62(bytes: Uint8Array): string {
  let n = BigInt(`0x${hex(bytes)}`);
  let out = "";

  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }

  return out;
}

async function main(): Promise<void> {
  const name = (process.argv[2] ?? "first key").replaceAll("'", "''");

  const permission =
    process.argv[3] === "sending_access" ? "sending_access" : "full_access";

  const token = `fs_${base62(crypto.getRandomValues(new Uint8Array(32)))}`;

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );

  const hash = hex(new Uint8Array(digest));
  const id = crypto.randomUUID();

  console.error(`API key (shown one time): ${token}`);
  console.log(
    `INSERT INTO api_keys (id, name, key_hash, prefix, permission, rate_limit, created_at) VALUES ('${id}', '${name}', '${hash}', '${token.slice(0, 10)}', '${permission}', 10, ${Date.now()});`,
  );
}

void main();
