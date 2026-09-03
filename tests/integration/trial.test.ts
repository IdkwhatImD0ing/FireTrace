import "./env";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAccessibleProject, listProjectsFor } from "@/lib/auth/access";
import { createSessionCookie, type Owner } from "@/lib/auth/session";
import { adminAuth } from "@/lib/firebase/admin";
import { createApiKey, createProject, deleteProject } from "@/lib/firetrace/projects";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { getTrialUsage, trialSubject } from "@/lib/firetrace/trial";
import { AUTH_HOST, OWNER_EMAIL, TEST_PEPPER } from "./env";
import { mcpTool } from "./api-helpers";
import {
  clearAuthAccounts,
  clearFirestore,
  createTestKey,
  createTestProject,
  db,
  OWNER_UID,
  postTrace,
  traceData,
} from "./helpers";

// Trial mode is a per-process setting; this file runs in its own module graph.
const LIMIT = 5;
process.env.FIRETRACE_TRIAL_TRACE_LIMIT = String(LIMIT);
process.env.NEXT_PUBLIC_REPOSITORY_URL = "https://github.com/example/FireTrace";

const GUEST_UID = "guest-uid";
const GUEST_EMAIL = "guest@example.com";
const PASSWORD = "integration-test-password";

const guest: Owner = {
  uid: GUEST_UID,
  email: GUEST_EMAIL,
  name: null,
  picture: null,
  role: "trial",
};
const owner: Owner = {
  uid: OWNER_UID,
  email: OWNER_EMAIL,
  name: null,
  picture: null,
  role: "owner",
};

function traceWithId(id: string) {
  const body = sampleTraceRequest();
  body.trace.id = id;
  return body;
}

async function idTokenFor(email: string, password: string): Promise<string> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const json = (await res.json()) as { idToken?: string };
  if (!json.idToken) throw new Error("emulator sign-in failed");
  return json.idToken;
}

function createGuestProject(name = "guest-sandbox") {
  return createProject(db(), {
    name,
    ownerUid: GUEST_UID,
    ownerEmail: GUEST_EMAIL,
    plan: "trial",
  });
}

describe("trial mode (FIRETRACE_TRIAL_TRACE_LIMIT=5) against the emulators", () => {
  beforeAll(async () => {
    await clearAuthAccounts();
    await adminAuth().createUser({ email: OWNER_EMAIL, password: PASSWORD, emailVerified: true });
    await adminAuth().createUser({ email: GUEST_EMAIL, password: PASSWORD, emailVerified: true });
    await adminAuth().createUser({
      email: "unverified@example.com",
      password: PASSWORD,
      emailVerified: false,
    });
  });

  beforeEach(async () => {
    await clearFirestore();
  });

  it("issues trial sessions to verified non-allowlisted accounts and owner sessions to the allowlist", async () => {
    const ownerSession = await createSessionCookie(await idTokenFor(OWNER_EMAIL, PASSWORD));
    expect(ownerSession.owner.role).toBe("owner");
    const guestSession = await createSessionCookie(await idTokenFor(GUEST_EMAIL, PASSWORD));
    expect(guestSession.owner.role).toBe("trial");
    expect(guestSession.owner.email).toBe(GUEST_EMAIL);
    await expect(
      createSessionCookie(await idTokenFor("unverified@example.com", PASSWORD)),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("limits trial accounts to one project and keeps their projects invisible to each other", async () => {
    const ownerProject = await createTestProject("owner-project");
    const guestProject = await createGuestProject();
    expect(guestProject.plan).toBe("trial");
    expect(guestProject.ownerEmail).toBe(GUEST_EMAIL);

    await expect(createGuestProject("second")).rejects.toMatchObject({
      status: 403,
      code: "trial_limit_reached",
    });

    expect((await listProjectsFor(db(), guest)).map((p) => p.id)).toEqual([guestProject.id]);
    expect((await listProjectsFor(db(), owner)).map((p) => p.id).sort()).toEqual(
      [ownerProject.id, guestProject.id].sort(),
    );
    expect(await getAccessibleProject(db(), guest, ownerProject.id)).toBeNull();
    expect((await getAccessibleProject(db(), owner, guestProject.id))?.id).toBe(guestProject.id);
    expect(await getAccessibleProject(db(), guest, "not-a-project-id")).toBeNull();

    const another: Owner = { ...guest, uid: "other-guest", email: "other@example.com" };
    expect(await getAccessibleProject(db(), another, guestProject.id)).toBeNull();
  });

  it("stops ingestion after the limit, does not count duplicates, and survives project deletion", async () => {
    const guestProject = await createGuestProject();
    const key = await createApiKey(db(), {
      projectId: guestProject.id,
      label: "guest",
      createdByUid: GUEST_UID,
      pepper: TEST_PEPPER,
    });

    for (let i = 1; i <= LIMIT; i++) {
      const res = await postTrace(traceWithId(`${i}`.padStart(32, "0")), key.plaintext);
      expect(res.status, `trace ${i}`).toBe(201);
    }
    expect((await getTrialUsage(db(), trialSubject(GUEST_EMAIL))).tracesUsed).toBe(LIMIT);

    const dup = await postTrace(traceWithId("1".padStart(32, "0")), key.plaintext);
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    expect((await getTrialUsage(db(), trialSubject(GUEST_EMAIL))).tracesUsed).toBe(LIMIT);

    const sixth = await postTrace(traceWithId("6".padStart(32, "0")), key.plaintext);
    expect(sixth.status).toBe(403);
    expect(sixth.body.error?.code).toBe("trial_limit_reached");
    expect(sixth.body.error?.message).toContain(
      "https://github.com/example/FireTrace#deploy-your-own",
    );
    expect(await traceData(guestProject.id, "6".padStart(32, "0"))).toBeNull();

    // Deleting the project and starting over does not refill the quota.
    await deleteProject(db(), guestProject.id);
    const fresh = await createGuestProject("fresh");
    const freshKey = await createApiKey(db(), {
      projectId: fresh.id,
      label: "guest-2",
      createdByUid: GUEST_UID,
      pepper: TEST_PEPPER,
    });
    const again = await postTrace(traceWithId("7".padStart(32, "0")), freshKey.plaintext);
    expect(again.status).toBe(403);
    expect(again.body.error?.code).toBe("trial_limit_reached");

    // The MCP write tool goes through the same gate.
    const viaMcp = await mcpTool(freshKey.plaintext, "record_trace", {
      trace: traceWithId("8".padStart(32, "0")).trace,
    });
    expect(viaMcp.result?.isError).toBe(true);
    expect(viaMcp.text).toContain("trial_limit_reached");
  });

  it("leaves owner projects unlimited", async () => {
    const ownerProject = await createTestProject("owner-project");
    const key = await createTestKey(ownerProject.id);
    for (let i = 1; i <= LIMIT + 2; i++) {
      const res = await postTrace(traceWithId(`${i}`.padStart(32, "a")), key.plaintext);
      expect(res.status, `owner trace ${i}`).toBe(201);
    }
    expect((await getTrialUsage(db(), trialSubject(OWNER_EMAIL))).tracesUsed).toBe(0);
  });
});
