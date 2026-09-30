// Types for free-form JSON from the Worker, for example the data of an
// email event or the body of an error response.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

// JSON.parse gives only JSON values. It throws on text that is not JSON.
export function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

export function isJsonObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isString(v: JsonValue | undefined): v is string {
  return typeof v === "string";
}

export function isNumber(v: JsonValue | undefined): v is number {
  return typeof v === "number";
}

export function isBoolean(v: JsonValue | undefined): v is boolean {
  return typeof v === "boolean";
}

// The text at a path in a JSON object: a string, or a number as a
// string. Other values give undefined.
export function pick(
  data: JsonObject | null,
  ...path: string[]
): string | undefined {
  let v: JsonValue | undefined = data;

  for (const k of path) {
    if (!isJsonObject(v)) return undefined;
    v = v[k];
  }

  return isString(v) || isNumber(v) ? String(v) : undefined;
}
