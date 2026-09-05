import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/firetrace/errors";
import {
  cursorFor,
  decodeSortCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_PAGE_SIZE,
  parseTraceFilters,
  parseTraceSort,
  TRACE_LIST_PARAMS,
  traceListQuery,
} from "@/lib/firetrace/queries";
import type { TraceSummary } from "@/lib/firetrace/types";

const TRACE_ID = "42f38ac8295345a7a12c4e3f60d6da23";
const STARTED_AT = "2026-09-02T19:01:02.120Z";

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("page sizes", () => {
  it("defaults to 50 and caps at 200", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50);
    expect(MAX_PAGE_SIZE).toBe(200);
  });
});

describe("cursor encoding", () => {
  it("round-trips a startedAt timestamp and trace id", () => {
    const cursor = encodeCursor(STARTED_AT, TRACE_ID);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodeSortCursor(cursor, "newest");
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    expect(decoded.traceId).toBe(TRACE_ID);
    expect(decoded.value).toBe(Date.parse(STARTED_AT));
    expect(new Date(decoded.value).toISOString()).toBe(STARTED_AT);
  });

  it("is opaque but deterministic", () => {
    expect(encodeCursor(STARTED_AT, TRACE_ID)).toBe(encodeCursor(STARTED_AT, TRACE_ID));
    expect(encodeCursor(STARTED_AT, TRACE_ID)).not.toContain(TRACE_ID);
    expect(encodeCursor("2026-09-02T19:01:03.000Z", TRACE_ID)).not.toBe(
      encodeCursor(STARTED_AT, TRACE_ID),
    );
  });

  it("rejects garbage and malformed payloads", () => {
    const decode = (cursor: string) => decodeSortCursor(cursor, "newest");
    expect(decode("")).toBeNull();
    expect(decode("not-base64!!!")).toBeNull();
    expect(decode(b64url("null"))).toBeNull();
    expect(decode(b64url("{}"))).toBeNull();
    expect(decode(b64url('{"0":1,"1":"x"}'))).toBeNull();
    expect(decode(b64url("[]"))).toBeNull();
    expect(decode(b64url('["1725303662120","42f38ac8295345a7a12c4e3f60d6da23"]'))).toBeNull();
    expect(decode(b64url("[1725303662120, 42]"))).toBeNull();
    expect(decode(b64url('[1725303662120,"short"]'))).toBeNull();
    expect(decode(b64url('[1725303662120,"42F38AC8295345A7A12C4E3F60D6DA23"]'))).toBeNull();
    expect(decode(b64url('[1e999,"42f38ac8295345a7a12c4e3f60d6da23"]'))).toBeNull();
    expect(decode(b64url('[1725303662120,"42f38ac8295345a7a12c4e3f60d6da23"'))).toBeNull();
  });

  it("never throws on hostile input", () => {
    for (const input of ["\0", "====", "%%%", "ey", "a".repeat(10_000)]) {
      expect(() => decodeSortCursor(input, "newest")).not.toThrow();
    }
  });
});

describe("parseTraceFilters", () => {
  it("returns no filters for empty params", () => {
    expect(parseTraceFilters({})).toEqual({
      status: undefined,
      model: undefined,
      sessionId: undefined,
      userId: undefined,
      name: undefined,
      tag: undefined,
      from: undefined,
      to: undefined,
    });
  });

  it("accepts known statuses and ignores unknown ones", () => {
    expect(parseTraceFilters({ status: "ok" }).status).toBe("ok");
    expect(parseTraceFilters({ status: "error" }).status).toBe("error");
    expect(parseTraceFilters({ status: "unset" }).status).toBe("unset");
    expect(parseTraceFilters({ status: "OK" }).status).toBeUndefined();
    expect(parseTraceFilters({ status: "failed" }).status).toBeUndefined();
  });

  it("trims strings, drops blanks, and truncates long values", () => {
    const filters = parseTraceFilters({
      model: "  example-model ",
      sessionId: "   ",
      userId: "u".repeat(300),
    });
    expect(filters.model).toBe("example-model");
    expect(filters.sessionId).toBeUndefined();
    expect(filters.userId).toBe("u".repeat(200));
  });

  it("uses the first value of repeated params", () => {
    expect(parseTraceFilters({ model: ["first", "second"] }).model).toBe("first");
    expect(parseTraceFilters({ status: ["error", "ok"] }).status).toBe("error");
    expect(parseTraceFilters({ model: [] }).model).toBeUndefined();
  });

  it("normalizes valid time bounds to ISO and ignores invalid ones", () => {
    const filters = parseTraceFilters({ from: "2026-09-01", to: "2026-09-02T19:01:02+02:00" });
    expect(filters.from).toBe("2026-09-01T00:00:00.000Z");
    expect(filters.to).toBe("2026-09-02T17:01:02.000Z");
    expect(parseTraceFilters({ from: "yesterday" }).from).toBeUndefined();
    expect(parseTraceFilters({ to: "" }).to).toBeUndefined();
  });

  it("ignores unrelated params", () => {
    const filters = parseTraceFilters({ after: "cursor", limit: "10", foo: "bar" });
    expect(Object.values(filters).every((v) => v === undefined)).toBe(true);
  });

  it("parses the environment filter, folding case, and drops an invalid one when lenient", () => {
    expect(parseTraceFilters({ environment: "Production" }).environment).toBe("production");
    expect(parseTraceFilters({ environment: "unassigned" }).environment).toBe("unassigned");
    expect(parseTraceFilters({ environment: "" }).environment).toBeUndefined();
    expect(parseTraceFilters({ environment: "no spaces allowed" }).environment).toBeUndefined();
  });
});

describe("strict parsing for the API", () => {
  const reject = (params: Record<string, string>) => {
    try {
      parseTraceFilters(params, { strict: true });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("invalid_request");
      return e.message;
    }
    throw new Error("expected a 400");
  };

  it("names an unknown status, sort, environment or time bound instead of ignoring it", () => {
    expect(reject({ status: "failed" })).toContain('"failed"');
    expect(reject({ status: "OK" })).toContain("ok, error, unset");
    expect(reject({ environment: "prod env" })).toContain('"prod env"');
    expect(reject({ from: "yesterday" })).toContain('"yesterday"');
    expect(reject({ to: "2026-13-45" })).toContain("to");
    expect(() => parseTraceSort("fastest", { strict: true })).toThrow(ApiError);
    expect(parseTraceSort("fastest")).toBe("newest");
    expect(parseTraceSort("", { strict: true })).toBe("newest");
  });

  it("still accepts every valid value", () => {
    expect(
      parseTraceFilters(
        { status: "error", environment: "Preview", from: "2026-09-01", sort: "slowest" },
        { strict: true },
      ),
    ).toMatchObject({ status: "error", environment: "preview", from: "2026-09-01T00:00:00.000Z" });
    expect(parseTraceSort("costliest", { strict: true })).toBe("costliest");
  });

  it("lists every supported list parameter for the unknown-parameter check", () => {
    expect([...TRACE_LIST_PARAMS]).toEqual([
      "status",
      "model",
      "name",
      "tag",
      "environment",
      "sessionId",
      "userId",
      "from",
      "to",
      "sort",
      "limit",
      "after",
      "before",
    ]);
  });
});

describe("traceListQuery", () => {
  it("keeps filters and a non-default sort but never the environment (that lives in the cookie)", () => {
    expect(traceListQuery({ status: "error", environment: "production" }, "slowest")).toBe(
      "?status=error&sort=slowest",
    );
    expect(traceListQuery({ environment: "unassigned" }, "newest")).toBe("");
  });
});

describe("name, tag and sort", () => {
  it("parses name and tag with their own length caps", () => {
    const filters = parseTraceFilters({ name: " answer-question ", tag: "t".repeat(80) });
    expect(filters.name).toBe("answer-question");
    expect(filters.tag).toBe("t".repeat(64));
    expect(parseTraceFilters({ name: "n".repeat(600) }).name).toHaveLength(500);
  });

  it("falls back to newest for unknown sorts", () => {
    expect(parseTraceSort(undefined)).toBe("newest");
    expect(parseTraceSort(null)).toBe("newest");
    expect(parseTraceSort("slowest")).toBe("slowest");
    expect(parseTraceSort(["costliest"])).toBe("costliest");
    expect(parseTraceSort("fastest")).toBe("newest");
  });

  it("mints sort-specific cursors that the default decoder refuses", () => {
    const trace = {
      id: TRACE_ID,
      startedAt: STARTED_AT,
      durationMs: 2692,
      costUsd: 0.0012,
    } as TraceSummary;
    expect(cursorFor(trace, "newest")).toBe(encodeCursor(STARTED_AT, TRACE_ID));
    const slow = cursorFor(trace, "slowest");
    expect(slow).not.toBe(cursorFor(trace, "costliest"));
    expect(JSON.parse(Buffer.from(slow, "base64url").toString("utf8"))).toEqual([
      2692,
      TRACE_ID,
      "slowest",
    ]);
    expect(decodeSortCursor(slow, "newest")).toBeNull();
    expect(decodeSortCursor(slow, "slowest")).toEqual({ value: 2692, traceId: TRACE_ID });
    expect(decodeSortCursor(cursorFor(trace, "newest"), "newest")?.traceId).toBe(TRACE_ID);
  });
});
