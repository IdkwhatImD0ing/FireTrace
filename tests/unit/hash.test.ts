import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical, sha256Hex, sortKeys } from "@/lib/firetrace/hash";
import type { JsonValue } from "@/lib/firetrace/schema";

describe("canonicalJson", () => {
  it("sorts object keys recursively and emits no whitespace", () => {
    const value: JsonValue = { z: 1, a: { d: [3, { y: 1, x: 2 }], c: null }, m: "s" };
    expect(canonicalJson(value)).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"m":"s","z":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([{ b: 1 }, { a: 2 }])).toBe('[{"b":1},{"a":2}]');
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ outer: { b: [1, { y: 0, x: 0 }], a: 1 } })).toBe(
      canonicalJson({ outer: { a: 1, b: [1, { x: 0, y: 0 }] } }),
    );
  });

  it("does not mutate its input", () => {
    const original = { b: { d: 1, c: 2 }, a: 1 };
    const sorted = sortKeys(original);
    expect(Object.keys(original)).toEqual(["b", "a"]);
    expect(Object.keys(original.b)).toEqual(["d", "c"]);
    expect(Object.keys(sorted as Record<string, JsonValue>)).toEqual(["a", "b"]);
    expect(sorted).not.toBe(original);
  });

  it("handles primitives and unicode", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson("é\n")).toBe('"é\\n"');
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });
});

describe("sha256Hex", () => {
  it("matches the SHA-256 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("accepts bytes as well as strings", () => {
    expect(sha256Hex(new Uint8Array(Buffer.from("abc")))).toBe(sha256Hex("abc"));
  });
});

describe("hashCanonical", () => {
  it("returns 64 lowercase hex characters", () => {
    expect(hashCanonical({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across key order", () => {
    const a = hashCanonical({ trace: { id: "x", name: "n" }, spans: [{ b: 1, a: 2 }] });
    const b = hashCanonical({ spans: [{ a: 2, b: 1 }], trace: { name: "n", id: "x" } });
    expect(a).toBe(b);
  });

  it("changes when content changes", () => {
    const base = hashCanonical({ a: 1, b: [1, 2] });
    expect(hashCanonical({ a: 2, b: [1, 2] })).not.toBe(base);
    expect(hashCanonical({ a: 1, b: [2, 1] })).not.toBe(base);
    expect(hashCanonical({ a: "1", b: [1, 2] })).not.toBe(base);
    expect(hashCanonical({ a: 1, b: [1, 2], c: null })).not.toBe(base);
  });

  it("equals the SHA-256 of the canonical JSON", () => {
    const value: JsonValue = { z: [1, { y: "a" }], a: null };
    const expected = createHash("sha256").update(canonicalJson(value)).digest("hex");
    expect(hashCanonical(value)).toBe(expected);
  });
});
