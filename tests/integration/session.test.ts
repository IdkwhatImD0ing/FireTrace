import "./env";
import { beforeAll, describe, expect, it } from "vitest";
import { createSessionCookie, NotAllowedError, verifySessionCookieValue } from "@/lib/auth/session";
import { adminAuth } from "@/lib/firebase/admin";
import { AUTH_HOST, OWNER_EMAIL } from "./env";
import { clearAuthAccounts } from "./helpers";

const PASSWORD = "integration-test-password";
const OUTSIDER_EMAIL = "outsider@example.com";

/** Sign in through the Auth emulator's Identity Toolkit REST API and return a Firebase ID token. */
async function idTokenFor(email: string, password: string): Promise<string> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const json = (await res.json()) as { idToken?: string; error?: { message?: string } };
  if (!res.ok || !json.idToken)
    throw new Error(`Emulator sign-in failed: ${json.error?.message ?? res.status}`);
  return json.idToken;
}

describe("dashboard session cookies against the Auth emulator", () => {
  let ownerUid = "";

  beforeAll(async () => {
    await clearAuthAccounts();
    ownerUid = (
      await adminAuth().createUser({
        email: OWNER_EMAIL,
        password: PASSWORD,
        emailVerified: false,
        displayName: "Owner",
      })
    ).uid;
    await adminAuth().createUser({
      email: OUTSIDER_EMAIL,
      password: PASSWORD,
      emailVerified: true,
    });
  });

  it("rejects an allowlisted account whose email is not verified", async () => {
    const idToken = await idTokenFor(OWNER_EMAIL, PASSWORD);
    await expect(createSessionCookie(idToken)).rejects.toBeInstanceOf(NotAllowedError);
    await expect(createSessionCookie(idToken)).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
      message: expect.stringMatching(/verify the email address/i),
    });
  });

  it("rejects a verified account that is not on the allowlist", async () => {
    const idToken = await idTokenFor(OUTSIDER_EMAIL, PASSWORD);
    await expect(createSessionCookie(idToken)).rejects.toBeInstanceOf(NotAllowedError);
    await expect(createSessionCookie(idToken)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("not in the dashboard allowlist"),
    });
  });

  it("issues a session cookie for the verified allowlisted owner and round-trips it", async () => {
    await adminAuth().updateUser(ownerUid, { emailVerified: true });
    const idToken = await idTokenFor(OWNER_EMAIL, PASSWORD);

    const { cookie, owner } = await createSessionCookie(idToken);
    expect(cookie.length).toBeGreaterThan(20);
    expect(owner).toMatchObject({ uid: ownerUid, email: OWNER_EMAIL, name: "Owner" });

    const verified = await verifySessionCookieValue(cookie);
    expect(verified).toMatchObject({ uid: ownerUid, email: OWNER_EMAIL });
  });

  it("returns null for missing, garbage, or foreign cookie values", async () => {
    expect(await verifySessionCookieValue(undefined)).toBeNull();
    expect(await verifySessionCookieValue("")).toBeNull();
    expect(await verifySessionCookieValue("not.a.jwt")).toBeNull();
    // A raw ID token is not a session cookie and must not be accepted as one.
    const idToken = await idTokenFor(OWNER_EMAIL, PASSWORD);
    const tampered = `${idToken.slice(0, -2)}xx`;
    expect(await verifySessionCookieValue(tampered)).toBeNull();
  });

  it("stops honouring a cookie once the account is disabled or deleted", async () => {
    const idToken = await idTokenFor(OWNER_EMAIL, PASSWORD);
    const { cookie } = await createSessionCookie(idToken);
    expect(await verifySessionCookieValue(cookie)).not.toBeNull();

    await adminAuth().updateUser(ownerUid, { disabled: true });
    expect(await verifySessionCookieValue(cookie)).toBeNull();

    await adminAuth().deleteUser(ownerUid);
    expect(await verifySessionCookieValue(cookie)).toBeNull();
  });
});
