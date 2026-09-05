/**
 * One-off migration for the linked-trace feedback workaround.
 *
 * Before `PATCH /api/v1/traces/{traceId}` existed, the only way to attach a
 * rating to a finished trace was to record a second, zero-duration trace whose
 * metadata pointed back at the first (`metadata.feedbackFor`). Those stand-ins
 * pollute trace counts and latency averages and burn quota on records that are
 * not LLM calls. This folds each one into its target trace's metadata and then
 * deletes it.
 *
 *   pnpm exec tsx scripts/backfill-feedback-metadata.ts --project <projectId>
 *   pnpm exec tsx scripts/backfill-feedback-metadata.ts --project <projectId> --apply
 *
 * The first form is a dry run that writes nothing; --apply migrates and deletes.
 *
 * Safety:
 *  - Dry run is the default; `--apply` is the only way to write or delete.
 *  - A stand-in whose target is missing is reported and left in place, never
 *    deleted, so feedback is not lost when the target has already been removed.
 *  - Re-running is safe: the patch is idempotent, and a stand-in is deleted
 *    only after its merge succeeds.
 *  - One failing candidate is reported and skipped; it does not strand the rest.
 *  - Metadata is not indexed, so finding candidates means scanning the
 *    project's traces. Expect one document read per trace in the project.
 */
import { pathToFileURL } from "node:url";
import type { Firestore } from "firebase-admin/firestore";
import { patchTraceMetadata } from "../src/lib/firetrace/metadata";
import { deleteTrace } from "../src/lib/firetrace/projects";
import type { JsonObject } from "../src/lib/firetrace/schema";
import { connectFirestore } from "./firestore-connect";

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const PROJECT_ID_RE = /^[0-9a-f]{24}$/;
const PAGE = 200;
const DEFAULT_PREFIX = "feedback.";

export interface Candidate {
  /** The zero-duration trace that only carries feedback. */
  fakeTraceId: string;
  /** The real trace it points at. */
  targetTraceId: string;
  /** Metadata to merge into the target, already prefixed. */
  patch: JsonObject;
}

/**
 * A trace is a feedback stand-in when its metadata names another trace through
 * `feedbackFor`. Everything else in its metadata becomes the patch, prefixed so
 * the migrated judgements stay distinguishable from ingest-time facts.
 */
export function toCandidate(
  fakeTraceId: string,
  metadata: unknown,
  prefix: string,
): Candidate | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const source = metadata as JsonObject;
  const target = source.feedbackFor;
  if (typeof target !== "string" || !TRACE_ID_RE.test(target.toLowerCase())) return null;
  if (target.toLowerCase() === fakeTraceId) return null;

  const patch: JsonObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "feedbackFor") continue;
    patch[`${prefix}${key}`] = value;
  }
  patch[`${prefix}migratedFrom`] = fakeTraceId;
  return { fakeTraceId, targetTraceId: target.toLowerCase(), patch };
}

export interface MigrateOptions {
  projectId: string;
  /** False (the default) reports what would happen and writes nothing. */
  apply: boolean;
  prefix?: string;
  log?: (message: string) => void;
}

export interface MigrateReport {
  scanned: number;
  /** Migrated, or would be migrated on a dry run. */
  migrated: number;
  deleted: number;
  /** Stand-ins whose target no longer exists; left in place. */
  orphaned: number;
  failed: number;
}

/** Scan a project's traces, fold every feedback stand-in into its target, delete it. */
export async function migrate(db: Firestore, options: MigrateOptions): Promise<MigrateReport> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const log = options.log ?? ((message: string) => console.log(message));
  const traces = db.collection("projects").doc(options.projectId).collection("traces");
  const report: MigrateReport = { scanned: 0, migrated: 0, deleted: 0, orphaned: 0, failed: 0 };
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  for (;;) {
    let page = traces.orderBy("__name__").limit(PAGE);
    if (cursor) page = page.startAfter(cursor);
    const snap = await page.get();
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1];

    for (const doc of snap.docs) {
      report.scanned++;
      const candidate = toCandidate(doc.id, doc.get("metadata"), prefix);
      if (!candidate) continue;

      if (!(await traces.doc(candidate.targetTraceId).get()).exists) {
        report.orphaned++;
        log(
          `  orphan: ${candidate.fakeTraceId} points at missing trace ${candidate.targetTraceId}; left in place`,
        );
        continue;
      }

      if (!options.apply) {
        report.migrated++;
        log(
          `  would merge ${candidate.fakeTraceId} -> ${candidate.targetTraceId} (${Object.keys(candidate.patch).join(", ")})`,
        );
        continue;
      }

      // One bad candidate (an oversized merge, say) must not strand the rest.
      try {
        await patchTraceMetadata(db, options.projectId, candidate.targetTraceId, candidate.patch);
        report.migrated++;
        await deleteTrace(db, options.projectId, candidate.fakeTraceId);
        report.deleted++;
        log(`  merged ${candidate.fakeTraceId} -> ${candidate.targetTraceId}`);
      } catch (err) {
        report.failed++;
        log(
          `  failed: ${candidate.fakeTraceId} -> ${candidate.targetTraceId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (snap.size < PAGE) break;
  }
  return report;
}

function parseArgs(argv: string[]): MigrateOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const projectId = get("--project") ?? "";
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      "Pass --project <projectId> (24 hex characters, from the dashboard URL).\n" +
        "  pnpm exec tsx scripts/backfill-feedback-metadata.ts --project 5eedc0ffee5eedc0ffee5eed",
    );
  }
  return { projectId, apply: argv.includes("--apply"), prefix: get("--prefix") ?? DEFAULT_PREFIX };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = connectFirestore();
  if (!(await db.collection("projects").doc(options.projectId).get()).exists) {
    throw new Error(`Project ${options.projectId} does not exist in this Firebase project.`);
  }
  console.log(
    options.apply
      ? `Migrating feedback traces in project ${options.projectId}. This deletes the stand-ins.`
      : `Dry run over project ${options.projectId}. Nothing will be written; add --apply to migrate.`,
  );

  const report = await migrate(db, options);
  console.log(
    `\nScanned ${report.scanned} traces. ${options.apply ? "Migrated" : "Would migrate"} ` +
      `${report.migrated}${options.apply ? `, deleted ${report.deleted} stand-in traces` : ""}. ` +
      `Orphans left alone: ${report.orphaned}. Failed: ${report.failed}.`,
  );
  if (!options.apply && report.migrated > 0) {
    console.log("Re-run with --apply to make these changes.");
  }
  if (report.failed > 0) process.exitCode = 1;
}

// Only run when executed directly, so the exports above stay testable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
