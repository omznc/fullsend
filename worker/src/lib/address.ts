export interface Address {
  name?: string;
  email: string;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// Parses "addr@x" or "Name <addr@x>". Returns null for a bad address.
export function parseAddress(input: string): Address | null {
  const value = input.trim();
  const match = /^(.*)<([^<>]+)>$/.exec(value);

  if (match) {
    const email = match[2]!.trim();

    if (!EMAIL.test(email)) return null;

    const name = match[1]!
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();

    return name ? { name, email } : { email };
  }

  return EMAIL.test(value) ? { email: value } : null;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

// The bare address in lower case, for suppression checks.
export function normalize(input: string): string {
  return (parseAddress(input)?.email ?? input).trim().toLowerCase();
}
