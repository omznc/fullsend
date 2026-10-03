import type { Context } from "hono";
import type { RouterRoute } from "hono/types";
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

// The methods that a route accepts for the path. A wildcard route and an
// ALL route do not count: they are catch-alls, not real endpoints.
export function allowedMethods(
  routes: readonly RouterRoute[],
  path: string,
): string[] {
  const methods = new Set<string>();

  for (const route of routes) {
    if (route.method === "ALL" || route.path.includes("*")) continue;

    const pattern = route.path
      .split("/")
      .map((part) =>
        part.startsWith(":")
          ? "[^/]+"
          : part.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&"),
      )
      .join("/");

    if (new RegExp(`^${pattern}$`).test(path)) methods.add(route.method);
  }

  return [...methods].toSorted();
}

export const methodNotAllowed = (allowed: readonly string[]) =>
  new ApiError(405, "method_not_allowed", "Method not allowed", {
    allow: allowed.join(", "),
  });

const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

// True for a lowercase DNS name with two labels or more.
export const isHostname = (value: string): boolean => HOSTNAME.test(value);
