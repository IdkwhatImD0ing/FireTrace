/**
 * Give stored traces an environment after the fact.
 *
 * Traces take their environment from the API key at ingest and are never
 * rewritten by FireTrace itself, so everything recorded before environments
 * existed (or by a key without one) is "unassigned". This script is the one
 * deliberate way to classify that history. Two forms:
 *
 *   pnpm exec tsx scripts/backfill-environment.ts --project <projectId> [--apply]
 *     Mark history: write `environment: null` onto every trace that has no
 *     `environment` field at all. Firestore cannot query for a missing field,
 *     so without this `?environment=unassigned` and the dashboard's
 *     "unassigned" selection cannot find traces recorded before the upgrade.
 *
 *   pnpm exec tsx scripts/backfill-environment.ts --project <projectId> --environment <slug>
 *       [--key <keyId>] [--tag <tag>] [--from <ISO>] [--to <ISO>] [--overwrite] [--apply]
 *     Assign: set `environment` on the traces matching every selector given
 *     (AND). `--key` matches the key that recorded the trace (recorded on
 *     traces ingested since environments existed), `--tag` a tag the trace
 *     carries (the `env:production` convention older integrations used),
 *     `--from`/`--to` bound `startedAt`. Only unassigned traces change unless
 *     `--overwrite` is given.
 *
 * Both forms end by rebuilding the dashboard rollups, because moving traces
 * between environments moves their numbers. Dry run by default; `--apply`
 * writes. Nothing is ever deleted. Every trace in the project is read once.
 * Ingest that lands while it runs can be missed; run when the project is quiet.
 */
import { pathToFileURL } from "node:url";
import { FieldPath, Timestamp, type Firestore, type Query } from "firebase-admin/firestore";
import { normalizeEnvironment } from "../src/lib/firetrace/environment";
import { describeRebuild, rebuildStats, type RebuildReport } from "./backfill-stats";
import { connectFirestore } from "./firestore-connect";

const PROJECT_ID_RE = /^[0-9a-f]{24}$/;
const KEY_ID_RE = /^[0-9a-f]{16}$/;
const PAGE = 300;
const WRITE_BATCH = 400;

export interface AssignOptions {
  projectId: string;
  /** Null marks traces without the field as unassigned; a slug assigns it. */
  environment: string | null;
  keyId?: string;
  tag?: string;
  /** ISO instants bounding startedAt, inclusive. */
  from?: string;
  to?: string;
  /** Also relabel traces that already carry an environment. */
  overwrite: boolean;
  apply: boolean;
  log?: (message: string) => void;
}

export interface AssignReport {
  scanned: number;
  matched: number;
  updated: number;
  rollups: RebuildReport | null;
}

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

/** Pure selection rule, exported for tests. `data` is the trace document. */
export function selects(data: FirebaseFirestore.DocumentData, options: AssignOptions): boolean {
  const hasField = "environment" in data;
  const current = typeof data.environment === "string" ? data.environment : null;
  if (options.environment === null) {
    // Marking history: only traces that lack the field entirely.
    if (hasField) return false;
  } else if (current !== null && !options.overwrite) {
    return false;
  } else if (current === options.environment) {
    return false;
  }
  if (options.keyId && data.keyId !== options.keyId) return false;
  if (options.tag && !(Array.isArray(data.tags) && data.tags.includes(options.tag))) return false;
  if (options.from || options.to) {
    const startedAt = data.startedAt instanceof Timestamp ? data.startedAt.toMillis() : null;
    if (startedAt === null) return false;
    if (options.from && startedAt < Date.parse(options.from)) return false;
    if (options.to && startedAt > Date.parse(options.to)) return false;
  }
  return true;
}

export async function assignEnvironment(
  db: Firestore,
  options: AssignOptions,
): Promise<AssignReport> {
  const log = options.log ?? (() => undefined);
  const projectRef = db.collection("projects").doc(options.projectId);
  const refs: FirebaseFirestore.DocumentReference[] = [];
  let scanned = 0;
  for await (const doc of pages(
    projectRef.collection("traces").select("environment", "keyId", "tags", "startedAt"),
  )) {
    scanned++;
    if (selects(doc.data(), options)) refs.push(doc.ref);
  }
  log(
    `${scanned} trace(s) scanned, ${refs.length} ${
      options.environment === null
        ? "without an environment field"
        : `to set to "${options.environment}"`
    }.`,
  );

  let updated = 0;
  if (options.apply) {
    for (let i = 0; i < refs.length; i += WRITE_BATCH) {
      const batch = db.batch();
      for (const ref of refs.slice(i, i + WRITE_BATCH)) {
        batch.update(ref, { environment: options.environment });
      }
      await batch.commit();
      updated += Math.min(WRITE_BATCH, refs.length - i);
      log(`Updated ${updated} of ${refs.length} trace(s).`);
    }
  }

  // Traces moved between environments, so the per-environment rollups moved too.
  const rollups =
    refs.length > 0 || options.apply
      ? await rebuildStats(db, { projectId: options.projectId, apply: options.apply })
      : null;
  if (rollups) log(describeRebuild(rollups, options.apply));
  return { scanned, matched: refs.length, updated, rollups };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function isoOrThrow(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${name} must be an ISO 8601 timestamp, got "${value}".`);
  return new Date(ms).toISOString();
}

export function parseArgs(argv: string[]): AssignOptions {
  const projectId = flag(argv, "--project") ?? "";
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(
      "Pass --project <projectId> (24 hex characters, from the dashboard URL).\n" +
        "  pnpm exec tsx scripts/backfill-environment.ts --project 5eedc0ffee5eedc0ffee5eed --environment production --tag env:production",
    );
  }
  const rawEnvironment = flag(argv, "--environment");
  const environment = normalizeEnvironment(rawEnvironment);
  if (rawEnvironment !== undefined && environment === null) {
    throw new Error("--environment needs a slug; omit it to mark history as unassigned.");
  }
  const keyId = flag(argv, "--key");
  if (keyId !== undefined && !KEY_ID_RE.test(keyId)) {
    throw new Error("--key must be the 16-hex key id shown in the dashboard.");
  }
  const tag = flag(argv, "--tag");
  if (tag !== undefined && tag.trim() === "") throw new Error("--tag needs a value.");
  return {
    projectId,
    environment,
    keyId,
    tag,
    from: isoOrThrow("--from", flag(argv, "--from")),
    to: isoOrThrow("--to", flag(argv, "--to")),
    overwrite: argv.includes("--overwrite"),
    apply: argv.includes("--apply"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = connectFirestore();
  if (!(await db.collection("projects").doc(options.projectId).get()).exists) {
    throw new Error(`Project ${options.projectId} does not exist in this Firebase project.`);
  }
  console.log(
    options.apply
      ? `Updating project ${options.projectId}.`
      : `Dry run over project ${options.projectId}. Nothing will be written; add --apply to update.`,
  );
  const report = await assignEnvironment(db, { ...options, log: (m) => console.log(m) });
  console.log(
    options.apply
      ? `Done: ${report.updated} trace(s) updated.`
      : `${report.matched} trace(s) would be updated. Re-run with --apply.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
