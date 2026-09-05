/**
 * Rebuild the dashboard's per-day rollups (`projects/{id}/stats/{YYYY-MM-DD}`
 * and the per-environment twins in `projects/{id}/statsByEnv/{env}:{YYYY-MM-DD}`)
 * from the traces and scores a project holds. Run it once after upgrading to a
 * FireTrace that has the dashboard or environments, or whenever the numbers look off.
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
import { environmentFromDocument } from "../src/lib/firetrace/environment";
import {
  applyDeltas,
  chooseKey,
  envStatsDocId,
  scoreStatsDeltas,
  STATS_CAPS,
  STATS_COLLECTION,
  STATS_ENV_COLLECTION,
  statsDayId,
  traceStatsDeltas,
  type Delta,
  type TraceStatsInput,
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
  /** Day documents the data folds into (all environments together). */
  days: number;
  written: number;
  deleted: number;
  /** Per-environment day documents (one per environment and day). */
  environmentDays: number;
  environmentWritten: number;
  environmentDeleted: number;
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

function traceDeltas(day: Day, input: TraceStatsInput): Delta[] {
  return traceStatsDeltas(input, {
    model: chooseKey(
      day.byModel as Record<string, unknown> | undefined,
      input.model,
      STATS_CAPS.models,
    ),
    name: chooseKey(
      day.byName as Record<string, unknown> | undefined,
      input.name,
      STATS_CAPS.names,
    ),
  });
}

function scoreDeltas(day: Day, score: { name: string; value: number | string | boolean }): Delta[] {
  const existing = day.scores as Record<string, Record<string, unknown>> | undefined;
  const nameKey = chooseKey(existing, score.name, STATS_CAPS.scoreNames);
  const labelKey =
    typeof score.value === "number"
      ? null
      : chooseKey(
          existing?.[nameKey]?.values as Record<string, unknown> | undefined,
          String(score.value),
          STATS_CAPS.scoreLabels,
        );
  return scoreStatsDeltas(score, { name: nameKey, label: labelKey });
}

/** Get-or-create the in-memory day `id` in `map` and fold `deltasFor(day)` into it. */
function fold(map: Map<string, Day>, id: string, deltasFor: (day: Day) => Delta[]): void {
  let day = map.get(id);
  if (!day) {
    day = {};
    map.set(id, day);
  }
  applyDeltas(day, deltasFor(day), 1);
}

/** Replace a rollup collection with `days`, deleting documents no data folds into. */
async function writeCollection(
  db: Firestore,
  collection: FirebaseFirestore.CollectionReference,
  days: Map<string, Day>,
  apply: boolean,
): Promise<{ written: number; deleted: number }> {
  const existing = await collection.select().get();
  const stale = existing.docs.map((d) => d.id).filter((id) => !days.has(id));
  if (!apply) return { written: 0, deleted: 0 };
  const ops: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [
    ...[...days.entries()].map(
      ([id, day]) =>
        (batch: FirebaseFirestore.WriteBatch) =>
          batch.set(collection.doc(id), { ...day, updatedAt: Timestamp.now() }),
    ),
    ...stale.map((id) => (batch: FirebaseFirestore.WriteBatch) => batch.delete(collection.doc(id))),
  ];
  for (let i = 0; i < ops.length; i += WRITE_BATCH) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + WRITE_BATCH)) op(batch);
    await batch.commit();
  }
  return { written: days.size, deleted: stale.length };
}

/** Fold every trace and score into in-memory day documents; write them when `apply` is set. */
export async function rebuildStats(db: Firestore, options: RebuildOptions): Promise<RebuildReport> {
  const projectRef = db.collection("projects").doc(options.projectId);
  const days = new Map<string, Day>();
  const envDays = new Map<string, Day>();
  // Scores take their trace's environment, so remember it for every trace.
  const traceEnvironment = new Map<string, string | null>();

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
        "environment",
      ),
  )) {
    const d = doc.data();
    const startedAt = iso(d.startedAt);
    if (!startedAt) continue;
    const environment = environmentFromDocument(d.environment);
    traceEnvironment.set(doc.id, environment);
    const input: TraceStatsInput = {
      name: typeof d.name === "string" ? d.name : "",
      status: typeof d.status === "string" ? d.status : "unset",
      startedAt,
      durationMs: typeof d.durationMs === "number" ? d.durationMs : 0,
      model: typeof d.model === "string" ? d.model : null,
      usage: d.usage && typeof d.usage === "object" ? d.usage : {},
      costUsd: typeof d.costUsd === "number" ? d.costUsd : null,
      spanCount: typeof d.spanCount === "number" ? d.spanCount : 0,
    };
    const day = statsDayId(startedAt);
    fold(days, day, (existing) => traceDeltas(existing, input));
    fold(envDays, envStatsDocId(environment, day), (existing) => traceDeltas(existing, input));
    traces++;
  }

  let scores = 0;
  for await (const doc of pages(
    projectRef.collection("scores").select("name", "value", "createdAt", "traceId"),
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
    const score = { name: d.name, value };
    const environment =
      typeof d.traceId === "string" ? (traceEnvironment.get(d.traceId) ?? null) : null;
    const day = statsDayId(createdAt);
    fold(days, day, (existing) => scoreDeltas(existing, score));
    fold(envDays, envStatsDocId(environment, day), (existing) => scoreDeltas(existing, score));
    scores++;
  }

  const all = await writeCollection(
    db,
    projectRef.collection(STATS_COLLECTION),
    days,
    options.apply,
  );
  const perEnvironment = await writeCollection(
    db,
    projectRef.collection(STATS_ENV_COLLECTION),
    envDays,
    options.apply,
  );

  return {
    traces,
    scores,
    days: days.size,
    written: all.written,
    deleted: all.deleted,
    environmentDays: envDays.size,
    environmentWritten: perEnvironment.written,
    environmentDeleted: perEnvironment.deleted,
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

export function describeRebuild(report: RebuildReport, apply: boolean): string {
  return (
    `Read ${report.traces} traces and ${report.scores} scores across ${report.days} day(s) ` +
    `and ${report.environmentDays} environment-day(s). ` +
    (apply
      ? `Wrote ${report.written} + ${report.environmentWritten} day document(s), deleted ${report.deleted} + ${report.environmentDeleted} stale one(s).`
      : "Re-run with --apply to write them.")
  );
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
  console.log(describeRebuild(report, options.apply));
}

// Only run when executed directly, so the exports above stay testable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
