import { describe, expect, it } from "vitest";
import spec from "../../openapi.json";
import pkg from "../../package.json";
import { app } from "../src/index";
import { PUBLIC_PATHS } from "../src/public-paths";

// openapi.json at the repo root describes the public API. These tests fail
// when a public route and the file differ, in either direction.

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

const isPublic = (path: string) =>
  PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

// "METHOD /path/{param}" for each public route of the Hono app. A catch-all
// (ALL or a wildcard) is not an endpoint.
function routeKeys(): string[] {
  const keys = new Set<string>();

  for (const route of app.routes) {
    if (route.method === "ALL" || route.path.includes("*")) continue;

    if (!isPublic(route.path)) continue;

    keys.add(`${route.method} ${route.path.replaceAll(/:(\w+)/g, "{$1}")}`);
  }

  return [...keys].toSorted();
}

// "METHOD /path/{param}" for each operation in openapi.json.
function specKeys(): string[] {
  const keys: string[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method)) {
        keys.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }

  return keys.toSorted();
}

describe("openapi.json", () => {
  it("has each public route", () => {
    const documented = new Set(specKeys());

    expect(routeKeys().filter((k) => !documented.has(k))).toEqual([]);
  });

  it("has no operation without a route", () => {
    const routes = new Set(routeKeys());

    expect(specKeys().filter((k) => !routes.has(k))).toEqual([]);
  });

  it("has a unique operationId for each operation", () => {
    const ids: string[] = [];

    for (const item of Object.values(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (HTTP_METHODS.has(method) && "operationId" in op) {
          ids.push(op.operationId);
        }
      }
    }

    expect(ids).toHaveLength(specKeys().length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("documents the rate unit and the domain capabilities", () => {
    const metrics = spec.paths["/emails/metrics"].get;
    const create = spec.paths["/domains"].post;
    const body = create.requestBody.content["application/json"].schema;

    expect(metrics.description).toContain("percent");
    expect(Object.keys(body.properties)).toContain("capabilities");
  });

  it("has the version of the package", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.version).toBe(pkg.version);
  });
});
