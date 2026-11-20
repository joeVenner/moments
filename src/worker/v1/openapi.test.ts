import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";
import { OPENAPI_CONFIG, v1 } from "./index";
import { toIosOpenApiDocument } from "./iosOpenapi";

// The iOS client is generated from this committed file. Regenerate it with
// `npm run openapi:update` after changing any v1 route or schema.
const SNAPSHOT = fileURLToPath(new URL("../../../openapi/v1.json", import.meta.url));
const IOS_SNAPSHOT = fileURLToPath(
  new URL("../../../ios/MomentsKit/Sources/MomentsAPI/openapi.json", import.meta.url)
);

function currentDocument(): string {
  return `${JSON.stringify(v1.getOpenAPI31Document(OPENAPI_CONFIG), null, 2)}\n`;
}

describe("toIosOpenApiDocument", () => {
  it("drops string enums only, keeping everything else", () => {
    const input = {
      kind: { type: "string", enum: ["image", "video"], description: "d" },
      mode: { type: ["string", "null"], enum: ["a"] },
      list: [{ type: "string", enum: ["x"] }],
      count: { type: "integer", enum: [1, 2] },
    };
    expect(toIosOpenApiDocument(input)).toEqual({
      kind: { type: "string", description: "d" },
      mode: { type: ["string", "null"] },
      list: [{ type: "string" }],
      count: { type: "integer", enum: [1, 2] },
    });
  });
});

describe("openapi/v1.json", () => {
  it("matches the routes", () => {
    const current = currentDocument();
    if (process.env.UPDATE_OPENAPI === "1") writeFileSync(SNAPSHOT, current);
    expect(readFileSync(SNAPSHOT, "utf8"), "openapi/v1.json is stale: run npm run openapi:update").toBe(current);
  });

  it("has an up-to-date iOS copy", () => {
    const ios = `${JSON.stringify(toIosOpenApiDocument(v1.getOpenAPI31Document(OPENAPI_CONFIG)), null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI === "1") writeFileSync(IOS_SNAPSHOT, ios);
    expect(readFileSync(IOS_SNAPSHOT, "utf8"), "iOS openapi.json is stale: run npm run openapi:update").toBe(ios);
  });

  it("has only the string enums the iOS mapper re-validates", () => {
    // toIosOpenApiDocument drops string enums; ios/MomentsKit/Sources/MomentsAPI/WireMapper.swift
    // must check every one of them. Add the new field there before extending this list.
    const found: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${path}[${index}]`));
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.enum) && record.enum.every((value) => typeof value === "string")) found.push(path);
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };
    walk(v1.getOpenAPI31Document(OPENAPI_CONFIG).components?.schemas, "schemas");
    // ModerationRequest.status, UpdateEventAccessRequest.mode and CreateAdminEventRequest.kind are only sent by the
    // app, never decoded. AdminMoment's and AdminEvent.kind must be re-validated by the host mapper when the app
    // starts reading them.
    expect(found.sort()).toEqual([
      "schemas.AdminEvent.allOf[1].properties.kind",
      "schemas.AdminMoment.properties.moderation_status",
      "schemas.CreateAdminEventRequest.properties.kind",
      "schemas.Event.properties.access_mode",
      "schemas.HostPlan.properties.state",
      "schemas.Media.properties.kind",
      "schemas.ModerationRequest.properties.status",
      "schemas.UpdateEventAccessRequest.properties.mode",
    ]);
  });

  it("gives every operation an operationId and an error schema", () => {
    const doc = v1.getOpenAPI31Document(OPENAPI_CONFIG);
    const operations = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.values(item as Record<string, { operationId?: string; responses?: Record<string, unknown> }>).map(
        (operation) => ({ path, operation })
      )
    );
    expect(operations.length).toBeGreaterThanOrEqual(4);
    for (const { path, operation } of operations) {
      expect(operation.operationId).toMatch(/^[a-z][A-Za-z]+$/);
      expect(operation.responses).toHaveProperty("default");
      // Event routes can always answer "no such event".
      if (path.startsWith("/events/")) expect(operation.responses).toHaveProperty("404");
    }
  });

  it("marks every admin operation except sign-in as needing a host session", () => {
    const doc = v1.getOpenAPI31Document(OPENAPI_CONFIG);
    const admin = Object.entries(doc.paths ?? {})
      .filter(([path]) => path.startsWith("/admin/"))
      .flatMap(([path, item]) =>
        Object.entries(item as Record<string, { operationId?: string; security?: unknown }>).map(([method, operation]) => ({
          route: `${method} ${path}`,
          security: operation.security,
        }))
      );
    expect(admin.length).toBeGreaterThanOrEqual(3);
    for (const { route, security } of admin) {
      expect(security, route).toEqual(route === "post /admin/session" ? undefined : [{ hostSession: [] }]);
    }
  });

  it("is served at /api/v1/openapi.json", async () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request("https://moments.test/api/v1/openapi.json"), {} as Env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ openapi: "3.1.0", info: { title: "Moments API" } });
  });
});
