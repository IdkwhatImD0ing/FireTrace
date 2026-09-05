import { FieldPath, type Firestore } from "firebase-admin/firestore";
import { storedEnvironment } from "./environment";
import {
  bucketMidpointMs,
  decodeKey,
  envStatsKey,
  HIST_BUCKETS,
  STATS_COLLECTION,
  STATS_ENV_COLLECTION,
  type StatsDayDoc,
} from "./stats-rollup";

/**
 * Read side of the per-day rollups: pick a window, fetch its day documents
 * (at most 90) with one document-id range query, and fold them into the view
 * the dashboard renders. With an environment the same window is read from the
 * per-environment twin collection instead, so every number follows the
 * selector. Everything below `getProjectStats` is pure.
 */

export const STATS_RANGES = ["24h", "7d", "14d", "30d", "90d"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];
const RANGE_DAYS: Record<StatsRange, number> = {
  "24h": 1,
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90,
};
const TOP_ROWS = 20;

export function parseRange(value: string | string[] | undefined): StatsRange {
  const v = Array.isArray(value) ? value[0] : value;
  return (STATS_RANGES as readonly string[]).includes(v ?? "") ? (v as StatsRange) : "7d";
}

export interface Bucket {
  /** `YYYY-MM-DD` for days, `YYYY-MM-DDThh` for hours. */
  key: string;
  label: string;
}

export interface RangeWindow {
  range: StatsRange;
  hourly: boolean;
  fromDay: string;
  toDay: string;
  buckets: Bucket[];
}

function dayId(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The buckets shown for a range, ending at `now` (UTC). */
export function rangeWindow(range: StatsRange, now = Date.now()): RangeWindow {
  const end = new Date(now);
  if (range === "24h") {
    const currentHour = Date.UTC(
      end.getUTCFullYear(),
      end.getUTCMonth(),
      end.getUTCDate(),
      end.getUTCHours(),
    );
    const buckets: Bucket[] = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(currentHour - i * 3_600_000);
      const hh = String(d.getUTCHours()).padStart(2, "0");
      buckets.push({ key: `${dayId(d)}T${hh}`, label: `${hh}:00` });
    }
    return {
      range,
      hourly: true,
      fromDay: buckets[0].key.slice(0, 10),
      toDay: dayId(end),
      buckets,
    };
  }
  const days = RANGE_DAYS[range];
  const today = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const buckets: Bucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today - i * 86_400_000);
    buckets.push({ key: dayId(d), label: dayLabel(d) });
  }
  return {
    range,
    hourly: false,
    fromDay: buckets[0].key,
    toDay: buckets[buckets.length - 1].key,
    buckets,
  };
}

export interface TimePoint extends Bucket {
  traces: number;
  errors: number;
  costUsd: number;
  totalTokens: number;
}

export interface NameRow {
  /** Null for the `_other` overflow bucket. */
  name: string | null;
  traces: number;
  errors: number;
  avgMs: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
}

export interface ModelRow {
  model: string | null;
  traces: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ScoreRow {
  name: string | null;
  count: number;
  /** Mean of numeric values, or null for categorical/boolean scores. */
  average: number | null;
  values: Array<{ label: string | null; count: number }>;
}

export interface ProjectStats {
  range: StatsRange;
  hourly: boolean;
  /** Day documents found in the window; 0 means nothing was rolled up yet. */
  days: number;
  totals: {
    traces: number;
    errors: number;
    errorRate: number | null;
    costUsd: number;
    totalTokens: number;
    avgMs: number | null;
  };
  series: TimePoint[];
  byName: NameRow[];
  byModel: ModelRow[];
  scores: ScoreRow[];
}

/** Pre-dashboard deletions can drive a counter below zero; never show that. */
function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Approximate percentile from a half-octave histogram: the midpoint of the bucket holding it. */
export function percentile(hist: Record<string, number> | undefined, p: number): number | null {
  if (!hist) return null;
  const counts = Array.from({ length: HIST_BUCKETS }, (_, i) => n(hist[String(i)]));
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = p * total;
  let cumulative = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    cumulative += counts[i];
    if (cumulative >= target) return bucketMidpointMs(i);
  }
  return bucketMidpointMs(HIST_BUCKETS - 1);
}

function mergeHist(into: Record<string, number>, from: Record<string, number> | undefined) {
  for (const [bucket, count] of Object.entries(from ?? {})) {
    into[bucket] = (into[bucket] ?? 0) + n(count);
  }
}

/** Fold the day documents of a window into the dashboard view. Pure. */
export function buildStats(
  window: RangeWindow,
  docs: Array<{ id: string; data: StatsDayDoc }>,
): ProjectStats {
  const byId = new Map(docs.map((d) => [d.id, d.data]));
  const totals = { traces: 0, errors: 0, costUsd: 0, totalTokens: 0, durationMsSum: 0 };
  const names = new Map<
    string,
    { traces: number; errors: number; durationMsSum: number; hist: Record<string, number> }
  >();
  const models = new Map<string, ModelRow>();
  const scores = new Map<string, { count: number; sum: number; values: Map<string, number> }>();

  for (const doc of docs.map((d) => d.data)) {
    totals.traces += n(doc.traces);
    totals.errors += n(doc.errors);
    totals.costUsd += n(doc.costUsd);
    totals.totalTokens += n(doc.totalTokens);
    totals.durationMsSum += n(doc.durationMsSum);
    for (const [key, row] of Object.entries(doc.byName ?? {})) {
      const entry = names.get(key) ?? { traces: 0, errors: 0, durationMsSum: 0, hist: {} };
      entry.traces += n(row.traces);
      entry.errors += n(row.errors);
      entry.durationMsSum += n(row.durationMsSum);
      mergeHist(entry.hist, row.hist);
      names.set(key, entry);
    }
    for (const [key, row] of Object.entries(doc.byModel ?? {})) {
      const entry = models.get(key) ?? {
        model: decodeKey(key),
        traces: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      entry.traces += n(row.traces);
      entry.inputTokens += n(row.inputTokens);
      entry.outputTokens += n(row.outputTokens);
      entry.costUsd += n(row.costUsd);
      models.set(key, entry);
    }
    for (const [key, row] of Object.entries(doc.scores ?? {})) {
      const entry = scores.get(key) ?? { count: 0, sum: 0, values: new Map<string, number>() };
      entry.count += n(row.count);
      entry.sum += typeof row.sum === "number" && Number.isFinite(row.sum) ? row.sum : 0;
      for (const [label, count] of Object.entries(row.values ?? {})) {
        entry.values.set(label, (entry.values.get(label) ?? 0) + n(count));
      }
      scores.set(key, entry);
    }
  }

  const series: TimePoint[] = window.buckets.map((bucket) => {
    if (window.hourly) {
      const hourRow = byId.get(bucket.key.slice(0, 10))?.hours?.[
        String(Number(bucket.key.slice(11)))
      ];
      return {
        ...bucket,
        traces: n(hourRow?.traces),
        errors: n(hourRow?.errors),
        costUsd: n(hourRow?.costUsd),
        totalTokens: n(hourRow?.totalTokens),
      };
    }
    const day = byId.get(bucket.key);
    return {
      ...bucket,
      traces: n(day?.traces),
      errors: n(day?.errors),
      costUsd: n(day?.costUsd),
      totalTokens: n(day?.totalTokens),
    };
  });

  const byName: NameRow[] = [...names.entries()]
    .filter(([, e]) => e.traces > 0)
    .map(([key, e]) => ({
      name: decodeKey(key),
      traces: e.traces,
      errors: e.errors,
      avgMs: e.traces ? e.durationMsSum / e.traces : null,
      p50: percentile(e.hist, 0.5),
      p90: percentile(e.hist, 0.9),
      p95: percentile(e.hist, 0.95),
      p99: percentile(e.hist, 0.99),
    }))
    .sort((a, b) => b.traces - a.traces || (a.name ?? "~").localeCompare(b.name ?? "~"))
    .slice(0, TOP_ROWS);

  const byModel: ModelRow[] = [...models.values()]
    .filter((m) => m.traces > 0)
    .map((m) => ({
      model: m.model,
      traces: m.traces,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      costUsd: m.costUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.traces - a.traces)
    .slice(0, TOP_ROWS);

  const scoreRows: ScoreRow[] = [...scores.entries()]
    .filter(([, e]) => e.count > 0)
    .map(([key, e]) => {
      const values = [...e.values.entries()]
        .filter(([, count]) => count > 0)
        .map(([label, count]) => ({ label: decodeKey(label), count }))
        .sort((a, b) => b.count - a.count);
      return {
        name: decodeKey(key),
        count: e.count,
        average: values.length === 0 ? e.sum / e.count : null,
        values,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_ROWS);

  return {
    range: window.range,
    hourly: window.hourly,
    days: docs.length,
    totals: {
      traces: totals.traces,
      errors: totals.errors,
      errorRate: totals.traces ? totals.errors / totals.traces : null,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      avgMs: totals.traces ? totals.durationMsSum / totals.traces : null,
    },
    series,
    byName,
    byModel,
    scores: scoreRows,
  };
}

export async function getProjectStats(
  db: Firestore,
  projectId: string,
  range: StatsRange,
  /** An environment slug or `unassigned`; omitted = every environment. */
  environment?: string,
  now = Date.now(),
): Promise<ProjectStats> {
  const window = rangeWindow(range, now);
  const project = db.collection("projects").doc(projectId);
  const prefix = environment === undefined ? "" : `${envStatsKey(storedEnvironment(environment))}:`;
  const snap = await project
    .collection(environment === undefined ? STATS_COLLECTION : STATS_ENV_COLLECTION)
    .where(FieldPath.documentId(), ">=", `${prefix}${window.fromDay}`)
    .where(FieldPath.documentId(), "<=", `${prefix}${window.toDay}`)
    .get();
  return buildStats(
    window,
    snap.docs.map((d) => ({ id: d.id.slice(prefix.length), data: d.data() as StatsDayDoc })),
  );
}
