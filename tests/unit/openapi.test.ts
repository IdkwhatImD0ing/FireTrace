import { describe, expect, it } from "vitest";
import { ingestRequestJsonSchema, openApiDocument } from "@/lib/firetrace/openapi";
import { LIMITS } from "@/lib/firetrace/schema";

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

describe("openApiDocument", () => {
  const doc = openApiDocument("https://example.test") as {
    openapi: string;
    servers: Array<{ url: string }>;
    paths: Record<
      string,
      Record<string, { operationId?: string; responses?: Record<string, unknown> }>
    >;
    components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
  };

  it("describes every key-authenticated route with the bearer scheme", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://example.test");
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/mcp",
      "/api/v1/project",
      "/api/v1/traces",
      "/api/v1/traces/{traceId}",
    ]);
    expect(doc.paths["/api/v1/traces"].post.operationId).toBe("recordTrace");
    expect(doc.paths["/api/v1/traces"].get.operationId).toBe("listTraces");
    expect(doc.paths["/api/v1/traces/{traceId}"].get.operationId).toBe("getTrace");
    expect(doc.paths["/api/v1/traces/{traceId}"].delete.operationId).toBe("deleteTrace");
    expect(doc.paths["/api/v1/project"].get.operationId).toBe("getProject");
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: "http", scheme: "bearer" });
  });

  it("documents the ingest status codes and limits", () => {
    const post = doc.paths["/api/v1/traces"].post;
    expect(Object.keys(post.responses ?? {}).sort()).toEqual([
      "200",
      "201",
      "400",
      "401",
      "403",
      "409",
      "413",
      "429",
      "500",
    ]);
    const description = (post as { description: string }).description;
    expect(description).toContain(String(LIMITS.maxSpans));
    expect(description).toContain(String(LIMITS.maxRequestBytes));
  });

  it("only references schemas that exist (IngestResult is attached by the route)", () => {
    const refs = new Set(collectRefs(doc.paths));
    const known = new Set([...Object.keys(doc.components.schemas), "IngestResult"]);
    for (const ref of refs) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      expect(known.has(ref.replace("#/components/schemas/", ""))).toBe(true);
    }
  });
});

describe("ingestRequestJsonSchema", () => {
  it("is derived from the Zod schema and exposes the trace shape", () => {
    const schema = ingestRequestJsonSchema() as {
      type: string;
      required?: string[];
      properties: {
        schemaVersion: { const?: number };
        trace: { properties: Record<string, unknown> };
      };
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(expect.arrayContaining(["schemaVersion", "trace"]));
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(Object.keys(schema.properties.trace.properties)).toEqual(
      expect.arrayContaining(["id", "name", "status", "startedAt", "endedAt", "spans"]),
    );
  });
});
