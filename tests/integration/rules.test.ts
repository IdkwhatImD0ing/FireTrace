import "./env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMULATOR_PROJECT_ID, OWNER_EMAIL } from "./env";

/**
 * The browser never talks to Firestore directly; firestore.rules must deny
 * every read and write, for anonymous and signed-in clients alike, including
 * an allowlisted owner. All data access goes through the Admin SDK on the
 * server, which bypasses rules after its own authorization checks.
 */
const DOC_PATHS = ["projects/x", "projects/x/traces/y", "projects/x/traces/y/spans/z", "apiKeys/k"];
const COLLECTION_PATHS = ["projects", "projects/x/traces", "projects/x/traces/y/spans", "apiKeys"];

describe("firestore.rules deny all direct client access", () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: EMULATOR_PROJECT_ID,
      firestore: {
        rules: readFileSync(join(__dirname, "..", "..", "firestore.rules"), "utf8"),
        host: "127.0.0.1",
        port: 8080,
      },
    });
    await env.clearFirestore();
    // Seed real documents (rules disabled) so denied reads are not just "missing document".
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();
      await fs.doc("projects/x").set({ name: "x", traceCount: 1 });
      await fs.doc("projects/x/traces/y").set({ name: "y", status: "ok" });
      await fs.doc("projects/x/traces/y/spans/z").set({ name: "z", kind: "llm" });
      await fs.doc("apiKeys/k").set({ projectId: "x", keyHash: "deadbeef", revokedAt: null });
    });
  });

  afterAll(async () => {
    await env?.clearFirestore();
    await env?.cleanup();
  });

  const contexts: Array<[label: string, make: () => RulesTestContext]> = [
    ["unauthenticated client", () => env.unauthenticatedContext()],
    [
      "authenticated allowlisted owner",
      () =>
        env.authenticatedContext("owner-uid", {
          email: OWNER_EMAIL,
          email_verified: true,
          firebase: { sign_in_provider: "google.com" },
        }),
    ],
    [
      "authenticated stranger",
      () =>
        env.authenticatedContext("stranger-uid", {
          email: "stranger@example.com",
          email_verified: true,
        }),
    ],
  ];

  for (const [label, make] of contexts) {
    describe(label, () => {
      for (const path of DOC_PATHS) {
        it(`cannot read, create, update or delete ${path}`, async () => {
          const fs = make().firestore();
          await assertFails(fs.doc(path).get());
          await assertFails(fs.doc(path).set({ injected: true }));
          await assertFails(fs.doc(path).set({ injected: true }, { merge: true }));
          await assertFails(fs.doc(path).update({ injected: true }));
          await assertFails(fs.doc(path).delete());
        });
      }
      for (const path of COLLECTION_PATHS) {
        it(`cannot list or add to ${path}`, async () => {
          const fs = make().firestore();
          await assertFails(fs.collection(path).get());
          await assertFails(fs.collection(path).limit(1).get());
          await assertFails(fs.collection(path).add({ injected: true }));
        });
      }
      it("cannot run collection-group queries", async () => {
        const fs = make().firestore();
        await assertFails(fs.collectionGroup("spans").get());
        await assertFails(fs.collectionGroup("traces").get());
      });
    });
  }

  it("leaves the seeded documents untouched after every denied write", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const fs = ctx.firestore();
      expect((await fs.doc("projects/x").get()).data()).toEqual({ name: "x", traceCount: 1 });
      expect((await fs.doc("projects/x/traces/y").get()).data()).toEqual({
        name: "y",
        status: "ok",
      });
      expect((await fs.doc("apiKeys/k").get()).data()).toEqual({
        projectId: "x",
        keyHash: "deadbeef",
        revokedAt: null,
      });
      expect((await fs.collection("projects").get()).size).toBe(1);
    });
  });
});
