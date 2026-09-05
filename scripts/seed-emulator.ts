/**
 * Seed the local emulators with an allowlisted owner account, one project, an
 * API key and a few sample traces. Development only; refuses to run unless
 * FIRETRACE_USE_EMULATORS=true so it can never touch a real project.
 *
 *   pnpm emulators            # in one terminal
 *   pnpm seed:emulator        # in another
 *
 * Prints the plaintext API key so `pnpm trace:example` can use it.
 */
import { createHmac } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { generateApiKey } from "../src/lib/firetrace/api-keys";
import { ingestTrace } from "../src/lib/firetrace/ingest";
import { normalizeIngestBody } from "../src/lib/firetrace/normalize";
import { sampleTraceRequest } from "../src/lib/firetrace/sample";

if (process.env.FIRETRACE_USE_EMULATORS !== "true") {
  console.error(
    "Refusing to seed: set FIRETRACE_USE_EMULATORS=true (this script only targets the emulators).",
  );
  process.exit(1);
}
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "demo-firetrace";
const pepper =
  process.env.FIRETRACE_KEY_PEPPER ?? "local-development-pepper-not-for-production-use";
const ownerEmail = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? "firetrace-dev-password";

const app = getApps()[0] ?? initializeApp({ projectId });
const db = getFirestore(app);
const auth = getAuth(app);

async function main() {
  // 1. Owner account (email/password, verified) for the login page.
  let uid: string;
  try {
    uid = (await auth.getUserByEmail(ownerEmail)).uid;
  } catch {
    uid = (
      await auth.createUser({
        email: ownerEmail,
        password: ownerPassword,
        emailVerified: true,
        displayName: "Local Owner",
      })
    ).uid;
  }

  // 2. Project.
  const projectRef = db.collection("projects").doc("5eedc0ffee5eedc0ffee5eed");
  if (!(await projectRef.get()).exists) {
    await projectRef.set({
      name: "sandbox",
      slug: "sandbox",
      description: "Seeded for local development",
      ownerUid: uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastTraceAt: null,
      traceCount: 0,
      spanCount: 0,
      estimatedBytes: 0,
      settings: { captureContent: true },
    });
  }

  // 3. API key.
  const key = generateApiKey();
  await db
    .collection("apiKeys")
    .doc(key.keyId)
    .create({
      projectId: projectRef.id,
      label: "seed",
      keyHash: createHmac("sha256", pepper).update(key.plaintext).digest("hex"),
      lastFour: key.lastFour,
      createdAt: FieldValue.serverTimestamp(),
      createdByUid: uid,
      revokedAt: null,
    });

  // 4. Sample traces with distinct ids, spread over the last five days so the
  //    dashboard has something to chart.
  let stored = 0;
  for (let i = 0; i < 5; i++) {
    const id = (i + 1).toString(16).padStart(2, "0").repeat(16);
    const normalized = normalizeIngestBody(
      sampleTraceRequest({
        id,
        name: i % 2 ? "summarize-thread" : "answer-question",
        startedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
      }),
    );
    if (!normalized.ok) throw new Error(normalized.error.message);
    const outcome = await ingestTrace(db, projectRef.id, normalized.value);
    if (outcome.created) stored++;
  }

  console.log(
    `Owner: ${ownerEmail} / ${ownerPassword} (allowlist it or run with an empty DASHBOARD_ALLOWED_EMAILS)`,
  );
  console.log(`Project: sandbox (${projectRef.id}) with ${stored} new sample traces`);
  console.log(`API key (plaintext, seed only): ${key.plaintext}`);
  console.log(`FIRETRACE_API_KEY=${key.plaintext} pnpm trace:example`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
