import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
  parseApiKey,
  redactedKeyReference,
  verifyApiKey,
} from "@/lib/firetrace/api-keys";

const PEPPER = "unit-test-pepper-0123456789abcdef0123456789abcdef";
const OTHER_PEPPER = "different-pepper-0123456789abcdef0123456789abcdef";
const KEY_RE = /^ft_live_([0-9a-f]{16})_([0-9a-f]{64})$/;

describe("generateApiKey", () => {
  it("produces ft_live_<16 hex>_<64 hex> with matching keyId and lastFour", () => {
    const key = generateApiKey();
    const match = KEY_RE.exec(key.plaintext);
    expect(match).not.toBeNull();
    if (!match) return;
    expect(match[1]).toBe(key.keyId);
    expect(key.lastFour).toBe(match[2].slice(-4));
    expect(key.plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  it("generates distinct keys and key ids", () => {
    const keys = Array.from({ length: 50 }, () => generateApiKey());
    expect(new Set(keys.map((k) => k.plaintext)).size).toBe(50);
    expect(new Set(keys.map((k) => k.keyId)).size).toBe(50);
  });
});

describe("parseApiKey", () => {
  it("extracts the key id from a well-formed key and trims whitespace", () => {
    const key = generateApiKey();
    expect(parseApiKey(key.plaintext)).toEqual({ keyId: key.keyId });
    expect(parseApiKey(`  ${key.plaintext}\n`)).toEqual({ keyId: key.keyId });
  });

  it("rejects malformed keys", () => {
    const key = generateApiKey();
    const secret = key.plaintext.slice(-64);
    expect(parseApiKey("")).toBeNull();
    expect(parseApiKey("ft_live_")).toBeNull();
    expect(parseApiKey(key.plaintext.toUpperCase())).toBeNull();
    expect(parseApiKey(`ft_test_${key.keyId}_${secret}`)).toBeNull();
    expect(parseApiKey(`ft_live_${key.keyId}_${secret.slice(1)}`)).toBeNull();
    expect(parseApiKey(`ft_live_${key.keyId}_${secret}0`)).toBeNull();
    expect(parseApiKey(`ft_live_${key.keyId.slice(1)}_${secret}`)).toBeNull();
    expect(parseApiKey(`ft_live_${key.keyId}${secret}`)).toBeNull();
    expect(parseApiKey(`Bearer ${key.plaintext}`)).toBeNull();
  });
});

describe("hashApiKey", () => {
  it("returns a deterministic 64-character hex HMAC-SHA-256 digest", () => {
    const key = generateApiKey();
    const digest = hashApiKey(key.plaintext, PEPPER);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key.plaintext, PEPPER)).toBe(digest);
    expect(digest).toBe(createHmac("sha256", PEPPER).update(key.plaintext).digest("hex"));
  });

  it("depends on both the pepper and the plaintext", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(hashApiKey(a.plaintext, PEPPER)).not.toBe(hashApiKey(a.plaintext, OTHER_PEPPER));
    expect(hashApiKey(a.plaintext, PEPPER)).not.toBe(hashApiKey(b.plaintext, PEPPER));
  });

  it("never stores the plaintext inside the digest", () => {
    const key = generateApiKey();
    expect(hashApiKey(key.plaintext, PEPPER)).not.toContain(key.keyId);
  });
});

describe("verifyApiKey", () => {
  it("accepts the matching key, pepper, and digest", () => {
    const key = generateApiKey();
    const stored = hashApiKey(key.plaintext, PEPPER);
    expect(verifyApiKey(key.plaintext, PEPPER, stored)).toBe(true);
  });

  it("rejects the wrong key", () => {
    const key = generateApiKey();
    const stored = hashApiKey(key.plaintext, PEPPER);
    expect(verifyApiKey(generateApiKey().plaintext, PEPPER, stored)).toBe(false);
    expect(verifyApiKey(key.plaintext.slice(0, -1) + "0", PEPPER, stored)).toBe(false);
    expect(verifyApiKey("", PEPPER, stored)).toBe(false);
  });

  it("rejects the wrong pepper", () => {
    const key = generateApiKey();
    const stored = hashApiKey(key.plaintext, PEPPER);
    expect(verifyApiKey(key.plaintext, OTHER_PEPPER, stored)).toBe(false);
  });

  it("rejects stored digests with the wrong length or invalid hex", () => {
    const key = generateApiKey();
    const stored = hashApiKey(key.plaintext, PEPPER);
    expect(verifyApiKey(key.plaintext, PEPPER, stored.slice(0, 62))).toBe(false);
    expect(verifyApiKey(key.plaintext, PEPPER, `${stored}00`)).toBe(false);
    expect(verifyApiKey(key.plaintext, PEPPER, "")).toBe(false);
    expect(verifyApiKey(key.plaintext, PEPPER, "zz".repeat(32))).toBe(false);
    expect(verifyApiKey(key.plaintext, PEPPER, stored.toUpperCase())).toBe(true);
  });
});

describe("redactedKeyReference", () => {
  it("shows the prefix, key id, and last four characters only", () => {
    const key = generateApiKey();
    const reference = redactedKeyReference(key.keyId, key.lastFour);
    expect(reference).toBe(`ft_live_${key.keyId}_…${key.lastFour}`);
    expect(reference).not.toContain(key.plaintext.slice(-64));
    expect(parseApiKey(reference)).toBeNull();
  });
});
