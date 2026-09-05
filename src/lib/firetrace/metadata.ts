import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { ApiError, rethrowQuotaExhausted } from "./errors";
import { canonicalJson } from "./hash";
import { firestoreSizeEstimate, validateJsonShape } from "./json-shape";
import { byteLength } from "./normalize";
import { describeIssues, jsonObjectSchema, LIMITS, type JsonObject } from "./schema";

/**
 * PATCH /api/v1/traces/{traceId} — the one mutable part of a stored trace.
 *
 * Everything a trace was ingested with stays write-once; this merges keys into
 * `metadata` so judgements that only exist after the run (a thumbs rating, a
 * reviewer's verdict, an eval result) have somewhere to go. The merge is
 * shallow: a key in the patch replaces that top-level key outright, and keys
 * the patch does not mention are left alone.
 *
 * `bodyHash` is deliberately not recomputed, so re-sending the original trace
 * is still recognised as a duplicate rather than a `409` conflict. It
 * therefore describes what was ingested, not what the document holds now.
 */
export const metadataPatchSchema = z.strictObject({
  metadata: jsonObjectSchema,
});
export type MetadataPatch = z.infer<typeof metadataPatchSchema>;

export type NormalizePatchResult =
  | { ok: true; value: JsonObject }
  | { ok: false; error: { code: "invalid_request"; message: string } };

/** Validate a parsed PATCH body. Never throws. */
export function normalizeMetadataPatch(body: unknown): NormalizePatchResult {
  const parsed = metadataPatchSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_request", message: describeIssues(parsed.error) } };
  }
  const problem = validateJsonShape(parsed.data.metadata, "metadata");
  if (problem) return { ok: false, error: { code: "invalid_request", message: problem } };
  return { ok: true, value: parsed.data.metadata };
}

export interface MetadataPatchOutcome {
  metadata: JsonObject;
  /** False when the merge produced exactly what was already stored; nothing was written. */
  changed: boolean;
}

function objectField(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/**
 * Shallow-merge `patch` into the trace's metadata in one transaction, keeping
 * the storage estimate honest. Concurrent patches of different keys both
 * survive; concurrent patches of the same key are last-writer-wins.
 */
export async function patchTraceMetadata(
  db: Firestore,
  projectId: string,
  traceId: string,
  patch: JsonObject,
): Promise<MetadataPatchOutcome> {
  const projectRef = db.collection("projects").doc(projectId);
  const traceRef = projectRef.collection("traces").doc(traceId);

  try {
    return await db.runTransaction(async (tx) => {
      const [projectSnap, traceSnap] = await Promise.all([tx.get(projectRef), tx.get(traceRef)]);
      if (!projectSnap.exists) {
        throw new ApiError(
          401,
          "invalid_api_key",
          "The project for this API key no longer exists.",
        );
      }
      if (!traceSnap.exists) {
        throw new ApiError(404, "not_found", "No such trace in this project.");
      }

      const data = traceSnap.data() ?? {};
      const existing = objectField(data.metadata);
      const merged: JsonObject = { ...existing, ...patch };
      if (canonicalJson(merged) === canonicalJson(existing)) {
        return { metadata: merged, changed: false };
      }

      const candidate = { ...data, metadata: merged };
      const bytes = Math.max(byteLength(candidate), firestoreSizeEstimate(candidate));
      if (bytes > LIMITS.maxDocumentBytes) {
        throw new ApiError(
          413,
          "payload_too_large",
          `The merged trace document would be about ${bytes} bytes; the limit is ${LIMITS.maxDocumentBytes} bytes. Patch fewer or smaller metadata keys.`,
        );
      }

      const delta = byteLength(merged) - byteLength(existing);
      tx.update(traceRef, {
        metadata: merged,
        metadataUpdatedAt: FieldValue.serverTimestamp(),
        estimatedBytes: FieldValue.increment(delta),
      });
      tx.update(projectRef, {
        estimatedBytes: FieldValue.increment(delta),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { metadata: merged, changed: true };
    });
  } catch (err) {
    rethrowQuotaExhausted(err);
  }
}
