import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";
import { OPENAPI_CONFIG, v1 } from "./index";

// The iOS client is generated from this committed file. Regenerate it with
// `npm run openapi:update` after changing any v1 route or schema.
const SNAPSHOT = fileURLToPath(new URL("../../../openapi/v1.json", import.meta.url));

function currentDocument(): string {
  return `${JSON.stringify(v1.getOpenAPI31Document(OPENAPI_CONFIG), null, 2)}\n`;
}

describe("openapi/v1.json", () => {
  it("matches the routes", () => {
    const current = currentDocument();
    if (process.env.UPDATE_OPENAPI === "1") writeFileSync(SNAPSHOT, current);
    expect(readFileSync(SNAPSHOT, "utf8"), "openapi/v1.json is stale: run npm run openapi:update").toBe(current);
  });

  it("gives every operation an operationId and an error schema", () => {
    const doc = v1.getOpenAPI31Document(OPENAPI_CONFIG);
    const operations = Object.values(doc.paths ?? {}).flatMap((item) =>
      Object.values(item as Record<string, { operationId?: string; responses?: Record<string, unknown> }>)
    );
    expect(operations.length).toBeGreaterThanOrEqual(4);
    for (const operation of operations) {
      expect(operation.operationId).toMatch(/^[a-z][A-Za-z]+$/);
      expect(operation.responses).toHaveProperty("404");
    }
  });

  it("is served at /api/v1/openapi.json", async () => {
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request("https://moments.test/api/v1/openapi.json"), {} as Env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ openapi: "3.1.0", info: { title: "Moments API" } });
  });
});
