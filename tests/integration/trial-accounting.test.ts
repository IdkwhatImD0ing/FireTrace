import "./env";
import { beforeEach, describe, expect, it } from "vitest";
import { getAccessibleProject, listProjectsFor } from "@/lib/auth/access";
import type { Owner } from "@/lib/auth/session";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import { createApiKey, createProject, deleteProject, rotateApiKey } from "@/lib/firetrace/projects";
import { ingestTrace } from "@/lib/firetrace/ingest";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import { getTrialUsage, TRIAL_MAX_KEYS, trialSubject } from "@/lib/firetrace/trial";
import { OWNER_EMAIL, TEST_PEPPER } from "./env";
import { clearFirestore, createTestProject, db, OWNER_UID, postTrace, traceData } from "./helpers";

// Same per-process setting as trial.test.ts; this file has its own module graph.
const LIMIT = 3;
process.env.FIRETRACE_TRIAL_TRACE_LIMIT = String(LIMIT);

const GUEST_EMAIL = "guest@example.com";
const guest: Owner = {
  uid: "guest-1",
  email: GUEST_EMAIL,
  name: null,
  picture: null,
  role: "trial",
};

function trace(id: string) {
  const body = sampleTraceRequest();
  body.trace.id = id;
  return body;
}

function normalized(id: string) {
  const result = normalizeIngestBody(trace(id));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function guestProject(name: string, uid = "guest-1") {
  return createProject(db(), { name, ownerUid: uid, ownerEmail: GUEST_EMAIL, plan: "trial" });
}

function keyFor(projectId: string, extra: Partial<Parameters<typeof createApiKey>[1]> = {}) {
  return createApiKey(db(), {
    projectId,
    label: "k",
    createdByUid: "guest-1",
    pepper: TEST_PEPPER,
    ...extra,
  });
}

describe("trial accounting is keyed on the verified email and on current status", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("a recreated Firebase account (new uid, same email) keeps the cap and the project", async () => {
    const project = await guestProject("sandbox");
    const key = await keyFor(project.id);
    for (let i = 1; i <= LIMIT; i++) {
      expect((await postTrace(trace(`${i}`.padStart(32, "0")), key.plaintext)).status).toBe(201);
    }
    expect((await getTrialUsage(db(), trialSubject(GUEST_EMAIL))).tracesUsed).toBe(LIMIT);

    // The user deletes their account and signs up again: new uid, same email.
    const reborn: Owner = { ...guest, uid: "guest-2" };
    expect((await listProjectsFor(db(), reborn)).map((p) => p.id)).toEqual([project.id]);
    await expect(guestProject("second", "guest-2")).rejects.toMatchObject({
      status: 403,
      code: "trial_limit_reached",
    });

    await deleteProject(db(), project.id);
    const fresh = await guestProject("fresh", "guest-2");
    const freshKey = await keyFor(fresh.id, { createdByUid: "guest-2" });
    const refused = await postTrace(trace("9".padStart(32, "0")), freshKey.plaintext);
    expect(refused.status).toBe(403);
    expect(refused.body.error?.code).toBe("trial_limit_reached");
    expect(await traceData(fresh.id, "9".padStart(32, "0"))).toBeNull();
  });

  it("a demoted co-owner cannot see or use the projects they created as an owner", async () => {
    const asOwner = await createProject(db(), {
      name: "was-mine",
      ownerUid: "guest-1",
      ownerEmail: GUEST_EMAIL,
      plan: "owner",
    });
    expect((await listProjectsFor(db(), guest)).map((p) => p.id)).toEqual([]);
    expect(await getAccessibleProject(db(), guest, asOwner.id)).toBeNull();

    // They can still start a trial project of their own, which they do see.
    const mine = await guestProject("trial-now");
    expect((await listProjectsFor(db(), guest)).map((p) => p.id)).toEqual([mine.id]);
    expect((await getAccessibleProject(db(), guest, mine.id))?.id).toBe(mine.id);
  });

  it("a trial project whose creator is now allowlisted records without a cap", async () => {
    const project = await guestProject("promoted");
    const options = {
      trialTraceLimit: LIMIT,
      repositoryUrl: "https://github.com/example/FireTrace",
      allowedEmails: [OWNER_EMAIL, GUEST_EMAIL],
    };
    for (let i = 1; i <= LIMIT + 2; i++) {
      const outcome = await ingestTrace(
        db(),
        project.id,
        normalized(`${i}`.padStart(32, "a")),
        options,
      );
      expect(outcome.created, `trace ${i}`).toBe(true);
    }
    expect((await getTrialUsage(db(), trialSubject(GUEST_EMAIL))).tracesUsed).toBe(0);

    // The same project is capped again the moment the email leaves the allowlist.
    await expect(
      ingestTrace(db(), project.id, normalized("f".repeat(32)), {
        ...options,
        allowedEmails: [OWNER_EMAIL],
        trialTraceLimit: 0,
      }),
    ).rejects.toMatchObject({ status: 403, code: "trial_limit_reached" });
  });

  it("scopes trial name uniqueness to the account and checks the cap first", async () => {
    const ownerProject = await createTestProject("production");
    // A trial user may use a name the owner already uses...
    const mine = await guestProject("production");
    expect(mine.slug).toBe(ownerProject.slug);
    // ...and a capped trial account gets the cap error, not a name oracle.
    await expect(guestProject("production")).rejects.toMatchObject({ code: "trial_limit_reached" });
    await expect(guestProject("staging")).rejects.toMatchObject({ code: "trial_limit_reached" });
  });

  it("caps API keys per trial project, revoked ones included, on creation and rotation", async () => {
    const project = await guestProject("keys");
    const keys = [];
    for (let i = 0; i < TRIAL_MAX_KEYS; i++) {
      keys.push(await keyFor(project.id, { plan: "trial", maxKeys: TRIAL_MAX_KEYS }));
    }
    await expect(
      keyFor(project.id, { plan: "trial", maxKeys: TRIAL_MAX_KEYS }),
    ).rejects.toMatchObject({
      status: 403,
      code: "trial_limit_reached",
    });
    await expect(
      rotateApiKey(db(), {
        projectId: project.id,
        keyId: keys[0].key.id,
        createdByUid: "guest-1",
        pepper: TEST_PEPPER,
        maxKeys: TRIAL_MAX_KEYS,
      }),
    ).rejects.toMatchObject({ code: "trial_limit_reached" });
    // Owner projects are not limited.
    const ownerProject = await createTestProject("unlimited");
    for (let i = 0; i < TRIAL_MAX_KEYS + 1; i++) {
      await createApiKey(db(), {
        projectId: ownerProject.id,
        label: "k",
        createdByUid: OWNER_UID,
        pepper: TEST_PEPPER,
      });
    }
  });
});
