import { describe, expect, it } from "vitest";
import {
  decodeScoreCursor,
  encodeScoreCursor,
  normalizeScoreInput,
  parseScoreFilters,
} from "@/lib/firetrace/scores";

function ok(body: unknown) {
  const result = normalizeScoreInput(body);
  if (!result.ok) throw new Error(`expected success, got: ${result.error.message}`);
  return result.value;
}

function failure(body: unknown) {
  const result = normalizeScoreInput(body);
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

describe("normalizeScoreInput", () => {
  it("accepts one score of each data type", () => {
    expect(ok({ name: "accuracy", dataType: "numeric", value: 0.75 })).toMatchObject({
      name: "accuracy",
      dataType: "numeric",
      value: 0.75,
    });
    expect(ok({ name: "topic", dataType: "categorical", value: "billing" }).value).toBe("billing");
    expect(ok({ name: "helpful", dataType: "boolean", value: false }).value).toBe(false);
  });

  it("keeps the optional comment and normalizes the span id", () => {
    const score = ok({
      name: "helpful",
      dataType: "boolean",
      value: true,
      comment: "answered the question",
      spanId: "ABCDEF0123456789",
    });
    expect(score.comment).toBe("answered the question");
    expect(score.spanId).toBe("abcdef0123456789");
  });

  it("insists that the value matches the data type", () => {
    expect(failure({ name: "accuracy", dataType: "numeric", value: "high" }).message).toContain(
      "value",
    );
    expect(failure({ name: "topic", dataType: "categorical", value: 1 }).message).toContain(
      "value",
    );
    expect(failure({ name: "helpful", dataType: "boolean", value: 1 }).message).toContain("value");
  });

  it("restricts names to a Firestore-safe alphabet", () => {
    for (const name of ["", "has.dot", "has space", "x".repeat(65), "emoji-🔥"]) {
      expect(failure({ name, dataType: "numeric", value: 1 }).message).toContain("name");
    }
    expect(ok({ name: "eval_v2-accuracy", dataType: "numeric", value: 1 }).name).toBe(
      "eval_v2-accuracy",
    );
  });

  it("rejects unknown keys, missing fields and oversized text", () => {
    expect(failure({ name: "a", dataType: "numeric", value: 1, id: "mine" }).message).toContain(
      "id",
    );
    expect(failure({ name: "a", value: 1 }).message).toContain("dataType");
    expect(failure({ name: "a", dataType: "numeric" }).message).toContain("value");
    expect(
      failure({ name: "a", dataType: "categorical", value: "x".repeat(201) }).message,
    ).toContain("value");
    expect(
      failure({ name: "a", dataType: "numeric", value: 1, comment: "x".repeat(2001) }).message,
    ).toContain("comment");
    expect(failure(null).code).toBe("invalid_request");
  });
});

describe("parseScoreFilters", () => {
  it("keeps valid names and ISO ranges, dropping anything else", () => {
    expect(
      parseScoreFilters({ name: "accuracy", from: "2026-09-01T00:00", to: "2026-09-02T00:00:00Z" }),
    ).toEqual({
      name: "accuracy",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-02T00:00:00.000Z",
    });
    expect(parseScoreFilters({ name: "bad.name", from: "yesterday" })).toEqual({
      name: undefined,
      from: undefined,
      to: undefined,
    });
  });
});

describe("score cursors", () => {
  it("round-trip and reject garbage", () => {
    const cursor = encodeScoreCursor("2026-09-02T19:01:02.120Z", "0123456789abcdef");
    const decoded = decodeScoreCursor(cursor);
    expect(decoded?.scoreId).toBe("0123456789abcdef");
    expect(decoded?.createdAt.toMillis()).toBe(Date.parse("2026-09-02T19:01:02.120Z"));
    expect(decodeScoreCursor("not-a-cursor")).toBeNull();
    expect(decodeScoreCursor(Buffer.from('["x","y"]').toString("base64url"))).toBeNull();
  });
});
