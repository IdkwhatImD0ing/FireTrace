import { describe, expect, it } from "vitest";
import {
  isProjectId,
  isSpanId,
  isTraceId,
  KEY_ID_RE,
  newKeyId,
  newProjectId,
  newRequestId,
  newSpanId,
  newTraceId,
  normalizeHexId,
  PROJECT_ID_RE,
  SPAN_ID_RE,
  TRACE_ID_RE,
} from "@/lib/firetrace/ids";

describe("id generation", () => {
  it("produces OpenTelemetry-shaped lowercase hex ids", () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newProjectId()).toMatch(/^[0-9a-f]{24}$/);
    expect(newKeyId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newRequestId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("matches the exported regexes", () => {
    expect(TRACE_ID_RE.test(newTraceId())).toBe(true);
    expect(SPAN_ID_RE.test(newSpanId())).toBe(true);
    expect(PROJECT_ID_RE.test(newProjectId())).toBe(true);
    expect(KEY_ID_RE.test(newKeyId())).toBe(true);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTraceId()));
    expect(ids.size).toBe(500);
    const spanIds = new Set(Array.from({ length: 500 }, () => newSpanId()));
    expect(spanIds.size).toBe(500);
  });
});

describe("id validation", () => {
  it("accepts well-formed lowercase ids", () => {
    expect(isTraceId("42f38ac8295345a7a12c4e3f60d6da23")).toBe(true);
    expect(isSpanId("00f067aa0ba902b7")).toBe(true);
    expect(isProjectId("0123456789abcdef01234567")).toBe(true);
  });

  it("rejects uppercase, wrong lengths, and non-hex characters", () => {
    expect(isTraceId("42F38AC8295345A7A12C4E3F60D6DA23")).toBe(false);
    expect(isTraceId("42f38ac8295345a7a12c4e3f60d6da2")).toBe(false);
    expect(isTraceId("42f38ac8295345a7a12c4e3f60d6da234")).toBe(false);
    expect(isTraceId("42f38ac8295345a7a12c4e3f60d6dazz")).toBe(false);
    expect(isTraceId("")).toBe(false);
    expect(isSpanId("00F067AA0BA902B7")).toBe(false);
    expect(isSpanId("00f067aa0ba902b")).toBe(false);
    expect(isSpanId("00f067aa0ba902b7 ")).toBe(false);
    expect(isProjectId("0123456789abcdef0123456")).toBe(false);
    expect(isProjectId("0123456789abcdef0123456g")).toBe(false);
  });
});

describe("normalizeHexId", () => {
  it("lowercases valid hex of the expected length", () => {
    expect(normalizeHexId("00F067AA0BA902B7", 16)).toBe("00f067aa0ba902b7");
    expect(normalizeHexId("00f067aa0ba902b7", 16)).toBe("00f067aa0ba902b7");
    expect(normalizeHexId("42F38AC8295345A7A12C4E3F60D6DA23", 32)).toBe(
      "42f38ac8295345a7a12c4e3f60d6da23",
    );
  });

  it("returns null for the wrong length, non-hex input, or non-strings", () => {
    expect(normalizeHexId("00f067aa0ba902b7", 32)).toBeNull();
    expect(normalizeHexId("00f067aa0ba902b", 16)).toBeNull();
    expect(normalizeHexId("00f067aa0ba902bg", 16)).toBeNull();
    expect(normalizeHexId("", 0)).toBeNull();
    expect(normalizeHexId(" 0f067aa0ba902b7", 16)).toBeNull();
    expect(normalizeHexId(12345678 as unknown as string, 8)).toBeNull();
    expect(normalizeHexId(null as unknown as string, 16)).toBeNull();
  });
});
