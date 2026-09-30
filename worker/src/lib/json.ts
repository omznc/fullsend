// JSON data from a request body, an RPC caller or a stored column. The
// validators read each field as a `JsonValue` and check it with the
// guards below.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

// A key can be absent. An RPC caller can also send `undefined`.
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

export function isBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}

// JSON.parse only makes JSON data, so its result is a JsonValue.
export function parseJsonText(text: string): JsonValue {
  const value: JsonValue = JSON.parse(text);

  return value;
}
