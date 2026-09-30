import type { Context } from "hono";
import { ApiError, validation } from "./errors";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseJsonText,
} from "./json";

export function parseJson(text: string): JsonValue {
  if (!text) return {};

  try {
    return parseJsonText(text);
  } catch {
    throw validation("The request body is not valid JSON.");
  }
}

export async function readJson(c: Context): Promise<JsonValue> {
  return parseJson(await c.req.text());
}

export function asRecord(value: JsonValue): JsonObject {
  if (!isJsonObject(value)) {
    throw validation("The request body must be a JSON object.");
  }

  return value;
}

export const methodNotAllowed = () =>
  new ApiError(405, "method_not_allowed", "Method not allowed");

const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

// True for a lowercase DNS name with two labels or more.
export const isHostname = (value: string): boolean => HOSTNAME.test(value);
