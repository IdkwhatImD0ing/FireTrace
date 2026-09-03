import { describe, expect, it } from "vitest";
import {
  describeIssues,
  ingestRequestSchema,
  LIMITS,
  SPAN_KINDS,
  spanInputSchema,
  STATUSES,
  usageSchema,
} from "@/lib/firetrace/schema";

describe("limits and enums", () => {
  it("pins the documented MVP limits", () => {
    expect(LIMITS).toEqual({
      maxSpans: 200,
      maxEventsPerSpan: 50,
      maxTags: 20,
      maxTagLength: 64,
      maxNameLength: 500,
      maxIdentifierLength: 200,
      maxRequestBytes: 2 * 1024 * 1024,
      maxDocumentBytes: 750 * 1024,
    });
    expect(LIMITS.maxDocumentBytes).toBeLessThan(1024 * 1024);
  });

  it("exposes the span kinds and statuses", () => {
    expect([...SPAN_KINDS]).toEqual([
      "llm",
      "agent",
      "tool",
      "chain",
      "retriever",
      "embedding",
      "reranker",
      "custom",
    ]);
    expect([...STATUSES]).toEqual(["ok", "error", "unset"]);
  });
});

describe("usageSchema", () => {
  it("accepts non-negative integers only", () => {
    expect(usageSchema.safeParse({}).success).toBe(true);
    expect(usageSchema.safeParse({ inputTokens: 0, outputTokens: 5 }).success).toBe(true);
    expect(usageSchema.safeParse({ inputTokens: -1 }).success).toBe(false);
    expect(usageSchema.safeParse({ inputTokens: 1.5 }).success).toBe(false);
    expect(usageSchema.safeParse({ inputTokens: "5" }).success).toBe(false);
  });
});

describe("spanInputSchema", () => {
  const base = {
    id: "00f067aa0ba902b7",
    name: "span",
    startedAt: "2026-09-02T19:01:02.120Z",
    endedAt: "2026-09-02T19:01:02.120Z",
  };

  it("defaults kind, status, parent, attributes, and events", () => {
    const parsed = spanInputSchema.parse(base);
    expect(parsed.kind).toBe("custom");
    expect(parsed.status).toBe("unset");
    expect(parsed.parentSpanId).toBeNull();
    expect(parsed.attributes).toEqual({});
    expect(parsed.events).toEqual([]);
  });

  it("rejects unknown kinds, statuses, and empty names", () => {
    expect(spanInputSchema.safeParse({ ...base, kind: "http" }).success).toBe(false);
    expect(spanInputSchema.safeParse({ ...base, status: "failed" }).success).toBe(false);
    expect(spanInputSchema.safeParse({ ...base, name: "" }).success).toBe(false);
    expect(
      spanInputSchema.safeParse({ ...base, name: "n".repeat(LIMITS.maxNameLength + 1) }).success,
    ).toBe(false);
  });

  it("rejects non-JSON input values", () => {
    expect(spanInputSchema.safeParse({ ...base, input: () => 1 }).success).toBe(false);
    expect(spanInputSchema.safeParse({ ...base, input: new Date() }).success).toBe(false);
    expect(spanInputSchema.safeParse({ ...base, attributes: [] }).success).toBe(false);
    expect(spanInputSchema.safeParse({ ...base, input: { nested: [1, "a", null] } }).success).toBe(
      true,
    );
  });
});

describe("describeIssues", () => {
  it("lists paths with messages and caps the output at five issues", () => {
    const result = ingestRequestSchema.safeParse({
      schemaVersion: 1,
      trace: {
        id: "bad",
        name: "",
        startedAt: "x",
        endedAt: "y",
        tags: [""],
        costUsd: -1,
        usage: { inputTokens: -1 },
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.length).toBeGreaterThan(5);
    const text = describeIssues(result.error);
    expect(text.split("; ")).toHaveLength(5);
    expect(text).toContain("trace.id: ");
    expect(text).toContain("trace.name: ");
  });

  it("labels root-level issues as (root)", () => {
    const result = ingestRequestSchema.safeParse({ schemaVersion: 1, trace: {}, extra: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(describeIssues(result.error)).toContain("(root): ");
  });
});
