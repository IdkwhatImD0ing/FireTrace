/**
 * Rebuild the dashboard's per-day rollups (`projects/{id}/stats/{YYYY-MM-DD}`)
 * from the traces and scores a project holds. Run it once after upgrading to a
 * FireTrace that has the dashboard, or whenever the numbers look off.
 *
 *   pnpm exec tsx scripts/backfill-stats.ts --project <projectId>
 *   pnpm exec tsx scripts/backfill-stats.ts --project <projectId> --apply
 *
 * The first form is a dry run that reports what it would write. With --apply
 * every day document is replaced wholesale and days with no data are deleted,
 * so the result is the same however often it runs. Ingest that lands while it
 * runs can be missed; re-run when the project is quiet. Nothing else is
 * touched: traces, spans and scores are only read.
 */
import { pathToFileURL } from "node:url";
import { FieldPath, Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import {
  applyDeltas,
  chooseKey,
  scoreStatsDeltas,
  STATS_CAPS,
  STATS_COLLECTION,
  statsDayId,
  traceStatsDeltas,
} from "../src/lib/firetrace/stats-rollup";
import { connectFirestore } from "./firestore-connect";

const PROJECT_ID_RE = /^[0-9a-f]{24}$/;
const PAGE = 300;
const WRITE_BATCH = 400;

export interface RebuildOptions {
  projectId: string;
  apply: boolean;
}

export interface RebuildReport {
  traces: number;
  scores: number;
  /** Day documents the data folds into. */
  days: number;
  written: number;
  deleted: number;
}

type Day = Record<string, unknown>;

async function* pages(base: Query): AsyncGenerator<FirebaseFirestore.QueryDocumentSnapshot> {
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = base.orderBy(FieldPath.documentId()).limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const doc of snap.docs) yield doc;
    if (snap.size < PAGE) return;
    last = snap.docs[snap.docs.length - 1];
  }
}

function iso(v: unknown): string | null {
  return v instanceof Timestamp ? v.toDate().toISOString() : null;
}

/** Fold every trace and score into in-memory day documents; write them when `apply` is set. */
export async function rebuildStats(db: Firestore, options: RebuildOptions): Promise<RebuildReport> {
  const projectRef = db.collection("projects").doc(options.projectId);
  const days = new Map<string, Day>();
  const dayFor = (id: string): Day => {
    let day = days.get(id);
    if (!day) {
      day = {};
      days.set(id, day);
    }
    return day;
  };

  let traces = 0;
  for await (const doc of pages(
    projectRef
      .collection("traces")
      .select(
        "name",
        "status",
        "startedAt",
        "durationMs",
        "model",
        "usage",
        "costUsd",
        "spanCount",
      ),
  )) {
    const d = doc.data();
    const startedAt = iso(d.startedAt);
    if (!startedAt) continue;
    const day = dayFor(statsDayId(startedAt));
    const model = typeof d.model === "string" ? d.model : null;
    const name = typeof d.name === "string" ? d.name : "";
    applyDeltas(
      day,
      traceStatsDeltas(
        {
          name,
          status: typeof d.status === "string" ? d.status : "unset",
          startedAt,
          durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
          model,
          usage: d.usage && typeof d.usage === "object" ? d.usage : {},
          costUsd: typeof d.costUsd === "number" ? d.costUsd : null,
          spanCount: typeof d.spanCount === "number" ? d.spanCount : 0,
        },
        {
          model: chooseKey(
            day.byModel as Record<string, unknown> | undefined,
            model,
            STATS_CAPS.models,
          ),
          name: chooseKey(
            day.byName as Record<string, unknown> | undefined,
            name,
            STATS_CAPS.names,
          ),
        },
      ),
      1,
    );
    traces++;
  }

  let scores = 0;
  for await (const doc of pages(
    projectRef.collection("scores").select("name", "value", "createdAt"),
  )) {
    const d = doc.data();
    const createdAt = iso(d.createdAt);
    const value = d.value;
    if (
      !createdAt ||
      typeof d.name !== "string" ||
      !(typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    ) {
      continue;
    }
    const day = dayFor(statsDayId(createdAt));
    const existing = day.scores as Record<string, Record<string, unknown>> | undefined;
    const nameKey = chooseKey(existing, d.name, STATS_CAPS.scoreNames);
    const labelKey =
      typeof value === "number"
        ? null
        : chooseKey(
            existing?.[nameKey]?.values as Record<string, unknown> | undefined,
            String(value),
            STATS_CAPS.scoreLabels,
          );
    applyDeltas(
      day,
      scoreStatsDeltas({ name: d.name, value }, { name: nameKey, label: labelKey }),
      1,
    );
    scores++;
  }

  const existing = await projectRef.collection(STATS_COLLECTION).select().get();
  const stale = existing.docs.map((d) => d.id).filter((id) => !days.has(id));

  if (options.apply) {
    const ops: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [
      ...[...days.entries()].map(
        ([id, day]) =>
          (batch: FirebaseFirestore.WriteBatch) =>
            batch.set(projectRef.collection(STATS_COLLECTION).doc(id), {
              ...day,
              updatedAt: Timestamp.now(),
            }),
      ),
      ...stale.map(
        (id) => (batch: FirebaseFirestore.WriteBatch) =>
          batch.delete(projectRef.collection(STATS_COLLECTION).doc(id)),
      ),
    ];
    for (let i = 0; i < ops.length; i += WRITE_BATCH) {
      const batch = db.batch();
      for (const op of ops.slice(i, i + WRITE_BATCH)) op(batch);
      await batch.commit();
    }
  }

  return {
    traces,
    scores,
    days: days.size,
    written: options.apply ? days.size : 0,
    deleted: options.apply ? stale.length : 0,
  };
}

function parseArgs(argv: string[]): RebuildOptions {
  const i = argv.indexOf("--project");
  const projectId = i >= 0 ? (argv[i + 1] ?? "") : "";
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      "Pass --project <projectId> (24 hex characters, from the dashboard URL).\n" +
        "  pnpm exec tsx scripts/backfill-stats.ts --project 5eedc0ffee5eedc0ffee5eed",
    );
  }
  return { projectId, apply: argv.includes("--apply") };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = connectFirestore();
  if (!(await db.collection("projects").doc(options.projectId).get()).exists) {
    throw new Error(`Project ${options.projectId} does not exist in this Firebase project.`);
  }
  console.log(
    options.apply
      ? `Rebuilding dashboard rollups for project ${options.projectId}.`
      : `Dry run over project ${options.projectId}. Nothing will be written; add --apply to rebuild.`,
  );
  const report = await rebuildStats(db, options);
  console.log(
    `Read ${report.traces} traces and ${report.scores} scores across ${report.days} day(s). ` +
      (options.apply
        ? `Wrote ${report.written} day document(s), deleted ${report.deleted} stale one(s).`
        : "Re-run with --apply to write them."),
  );
}

// Only run when executed directly, so the exports above stay testable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
