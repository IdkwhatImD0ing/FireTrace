import "./env";
import type { DocumentData } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/v1/traces/route";
import { adminDb } from "@/lib/firebase/admin";
import { createApiKey, createProject } from "@/lib/firetrace/projects";
import type { IngestRequest } from "@/lib/firetrace/schema";
import { AUTH_HOST, EMULATOR_PROJECT_ID, FIRESTORE_HOST, TEST_PEPPER } from "./env";

export const OWNER_UID = "owner-uid";
export const INGEST_URL = "http://localhost:3000/api/v1/traces";

export function db() {
  return adminDb();
}

/** Wipe every document in the Firestore emulator (REST endpoint, emulator only). */
export async function clearFirestore(): Promise<void> {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Failed to clear the Firestore emulator: HTTP ${res.status}`);
}

/** Delete every account in the Auth emulator. */
export async function clearAuthAccounts(): Promise<void> {
  const res = await fetch(
    `http://${AUTH_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/accounts`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) throw new Error(`Failed to clear the Auth emulator: HTTP ${res.status}`);
}

export function createTestProject(name: string) {
  return createProject(db(), { name, ownerUid: OWNER_UID });
}

export function createTestKey(projectId: string, label = "test") {
  return createApiKey(db(), { projectId, label, createdByUid: OWNER_UID, pepper: TEST_PEPPER });
}

export interface IngestJson {
  ok?: boolean;
  traceId?: string;
  projectId?: string;
  spanCount?: number;
  duplicate?: boolean;
  requestId?: string;
  error?: { code: string; message: string; requestId: string };
}

export interface IngestResult {
  status: number;
  body: IngestJson;
  headers: Headers;
}

/**
 * Call the real route handler with a standard Request. `body` may be a
 * pre-serialized string so malformed JSON and oversize payloads can be sent.
 */
export async function postTrace(
  body: IngestRequest | Record<string, unknown> | string,
  apiKey?: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<IngestResult> {
  const headers = new Headers({ "content-type": "application/json", ...extraHeaders });
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const request = new NextRequest(INGEST_URL, { method: "POST", headers, body: raw });
  const response = await POST(request);
  return {
    status: response.status,
    body: (await response.json()) as IngestJson,
    headers: response.headers,
  };
}

export async function projectData(projectId: string): Promise<DocumentData> {
  const snap = await db().collection("projects").doc(projectId).get();
  return snap.data() ?? {};
}

export async function traceData(projectId: string, traceId: string): Promise<DocumentData | null> {
  const snap = await db()
    .collection("projects")
    .doc(projectId)
    .collection("traces")
    .doc(traceId)
    .get();
  return snap.exists ? (snap.data() ?? {}) : null;
}

export async function traceIds(projectId: string): Promise<string[]> {
  const snap = await db().collection("projects").doc(projectId).collection("traces").get();
  return snap.docs.map((d) => d.id).sort();
}

export async function spanDocs(
  projectId: string,
  traceId: string,
): Promise<Array<{ id: string; data: DocumentData }>> {
  const snap = await db()
    .collection("projects")
    .doc(projectId)
    .collection("traces")
    .doc(traceId)
    .collection("spans")
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every span document anywhere under projects/{projectId}/... (collection-group scan). */
export async function spanPathsUnderProject(projectId: string): Promise<string[]> {
  const snap = await db().collectionGroup("spans").get();
  return snap.docs.map((d) => d.ref.path).filter((p) => p.startsWith(`projects/${projectId}/`));
}

export async function apiKeyIdsForProject(projectId: string): Promise<string[]> {
  const snap = await db().collection("apiKeys").where("projectId", "==", projectId).get();
  return snap.docs.map((d) => d.id).sort();
}
