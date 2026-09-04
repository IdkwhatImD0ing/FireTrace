import { describe, expect, it } from "vitest";
import { normalizeMetadataPatch } from "@/lib/firetrace/metadata";

function ok(body: unknown) {
  const result = normalizeMetadataPatch(body);
  if (!result.ok) throw new Error(`expected success, got: ${result.error.message}`);
  return result.value;
}

function failure(body: unknown) {
  const result = normalizeMetadataPatch(body);
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

describe("normalizeMetadataPatch", () => {
  it("accepts a metadata object and passes it through unchanged", () => {
    expect(ok({ metadata: { feedback: 1, label: "thumbs-up" } })).toEqual({
      feedback: 1,
      label: "thumbs-up",
    });
    expect(ok({ metadata: {} })).toEqual({});
  });

  it("accepts nested values, which the merge then replaces wholesale", () => {
    expect(ok({ metadata: { review: { verdict: "wrong", by: "sam" } } })).toEqual({
      review: { verdict: "wrong", by: "sam" },
    });
  });

  it("names the problem when the body is not a metadata patch", () => {
    expect(failure({}).message).toContain("metadata");
    expect(failure({ metadata: "thumbs-up" }).message).toContain("metadata");
    expect(failure({ metadata: [1, 2] }).message).toContain("metadata");
    expect(failure(null).message).toBeTruthy();
  });

  it("refuses to patch anything but metadata", () => {
    expect(failure({ metadata: {}, name: "renamed" }).message).toContain("name");
    expect(failure({ metadata: {}, status: "ok" }).message).toContain("status");
    expect(failure({ status: "ok" }).message).toContain("status");
  });

  it("rejects keys Firestore would refuse at commit time", () => {
    expect(failure({ metadata: { "": 1 } }).message).toContain("metadata");
    expect(failure({ metadata: { __name__: 1 } }).message).toContain("__name__");
  });

  it("reports invalid_request, the code the route turns into a 400", () => {
    expect(failure({}).code).toBe("invalid_request");
  });
});
