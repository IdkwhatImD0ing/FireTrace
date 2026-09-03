import { describe, expect, it } from "vitest";
import { decodeServiceAccount } from "@/lib/env/server";

const account = {
  type: "service_account",
  project_id: "demo-firetrace",
  client_email: "firebase-adminsdk@demo-firetrace.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
};
const json = JSON.stringify(account);
const base64 = Buffer.from(json, "utf8").toString("base64");

describe("decodeServiceAccount", () => {
  it("accepts single-line base64 of the key file", () => {
    const result = decodeServiceAccount(base64);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.json.client_email).toBe(account.client_email);
  });

  it("ignores line breaks and whitespace inside base64", () => {
    const wrapped = base64.match(/.{1,60}/g)!.join("\n") + "\n";
    expect(decodeServiceAccount(wrapped).ok).toBe(true);
  });

  it("accepts the raw JSON key file as well", () => {
    const result = decodeServiceAccount(`  ${json}\n`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.json.project_id).toBe("demo-firetrace");
  });

  it("rejects base64 that is not JSON", () => {
    const result = decodeServiceAccount(Buffer.from("not json").toString("base64"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain("not valid base64 JSON");
  });

  it("rejects JSON that is not a service account", () => {
    const result = decodeServiceAccount(JSON.stringify({ type: "authorized_user" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain("does not decode to a service-account JSON");
  });
});
