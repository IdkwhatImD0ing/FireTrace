import { FieldValue } from "firebase-admin/firestore";

/**
 * Per-day rollups behind the project dashboard: `projects/{id}/stats/{YYYY-MM-DD}`
 * (UTC day of `trace.startedAt`; scores use their `createdAt`). Firestore has
 * no ad-hoc aggregation, so ingest, score writes and deletes apply small
 * increments to these documents inside their own transactions, and the
 * dashboard reads at most 90 of them. Deletion of a trace or score subtracts
 * the same deltas; nothing here ever expires.
 *
 * Map keys (model, trace name, score name, label) are base64url so any name
 * becomes a legal field name; `_other` absorbs overflow beyond the per-day caps.
 */

export const STATS_COLLECTION = "stats";
/**
 * Per-environment twin of `stats`, so the dashboard's numbers can follow the
 * environment selector: `projects/{id}/statsByEnv/{environment}:{YYYY-MM-DD}`,
 * with `_unassigned` for traces that carry no environment. Same document
 * shape, same increments, one extra read and write per transaction.
 */
export const STATS_ENV_COLLECTION = "statsByEnv";
export const UNASSIGNED_STATS_KEY = "_unassigned";
export const OTHER_KEY = "_other";
export const HIST_BUCKETS = 48;
export const STATS_CAPS = { models: 100, names: 250, scoreNames: 50, scoreLabels: 50 } as const;

export function encodeKey(name: string): string {
  const key = Buffer.from(name, "utf8").toString("base64url");
  return key || OTHER_KEY;
}

/** Null for `_other` or an undecodable key. */
export function decodeKey(key: string): string | null {
  if (key === OTHER_KEY) return null;
  const text = Buffer.from(key, "base64url").toString("utf8");
  return text && encodeKey(text) === key ? text : null;
}

/** `2026-09-02T19:01:02.120Z` → `2026-09-02`. */
export function statsDayId(iso: string): string {
  return iso.slice(0, 10);
}

/** Id prefix of an environment's day documents; `:` is not a slug character, so prefixes never overlap. */
export function envStatsKey(environment: string | null): string {
  return environment ?? UNASSIGNED_STATS_KEY;
}

export function envStatsDocId(environment: string | null, day: string): string {
  return `${envStatsKey(environment)}:${day}`;
}

export function hourOf(iso: string): number {
  return new Date(iso).getUTCHours();
}

/** Half-octave log buckets: bucket i covers [2^(i/2), 2^((i+1)/2)) ms; the last is open-ended. */
export function latencyBucket(ms: number): number {
  const bucket = Math.floor(2 * Math.log2(Math.max(ms, 1)));
  return Math.min(HIST_BUCKETS - 1, Math.max(0, bucket));
}

export function bucketMidpointMs(bucket: number): number {
  return Math.pow(2, (bucket + 0.5) / 2);
}

/** The key to increment for `name`: its own once known, `_other` past the cap or when absent. */
export function chooseKey(
  existing: Record<string, unknown> | undefined,
  name: string | null,
  cap: number,
): string {
  if (!name) return OTHER_KEY;
  const key = encodeKey(name);
  if (existing && key in existing) return key;
  const used = existing ? Object.keys(existing).filter((k) => k !== OTHER_KEY).length : 0;
  return used < cap ? key : OTHER_KEY;
}

/** The key to decrement for `name`: only keys that exist; never creates one. */
export function existingKey(existing: Record<string, unknown> | undefined, name: string | null) {
  if (!name) return OTHER_KEY;
  const key = encodeKey(name);
  return existing && key in existing ? key : OTHER_KEY;
}

export type Delta = [path: string[], amount: number];

export interface TraceStatsInput {
  name: string;
  status: string;
  /** ISO 8601. */
  startedAt: string;
  durationMs: number;
  model: string | null;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  costUsd: number | null;
  spanCount: number;
}

function tokensOf(usage: TraceStatsInput["usage"]): number {
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function traceStatsDeltas(
  trace: TraceStatsInput,
  keys: { model: string; name: string },
): Delta[] {
  const err = trace.status === "error" ? 1 : 0;
  const input = trace.usage.inputTokens ?? 0;
  const output = trace.usage.outputTokens ?? 0;
  const total = tokensOf(trace.usage);
  const cost = trace.costUsd ?? 0;
  const hour = String(hourOf(trace.startedAt));
  const deltas: Delta[] = [
    [["traces"], 1],
    [["errors"], err],
    [["spans"], trace.spanCount],
    [["inputTokens"], input],
    [["outputTokens"], output],
    [["totalTokens"], total],
    [["costUsd"], cost],
    [["durationMsSum"], trace.durationMs],
    [["hours", hour, "traces"], 1],
    [["hours", hour, "errors"], err],
    [["hours", hour, "costUsd"], cost],
    [["hours", hour, "totalTokens"], total],
    [["byModel", keys.model, "traces"], 1],
    [["byModel", keys.model, "inputTokens"], input],
    [["byModel", keys.model, "outputTokens"], output],
    [["byModel", keys.model, "costUsd"], cost],
    [["byName", keys.name, "traces"], 1],
    [["byName", keys.name, "errors"], err],
    [["byName", keys.name, "durationMsSum"], trace.durationMs],
    [["byName", keys.name, "hist", String(latencyBucket(trace.durationMs))], 1],
  ];
  return deltas.filter(([, amount]) => amount !== 0);
}

export interface ScoreStatsInput {
  name: string;
  value: number | string | boolean;
}

/** `label` is the label key for categorical/boolean values; ignored for numbers. */
export function scoreStatsDeltas(
  score: ScoreStatsInput,
  keys: { name: string; label: string | null },
): Delta[] {
  const deltas: Delta[] = [[["scores", keys.name, "count"], 1]];
  if (typeof score.value === "number") {
    if (score.value !== 0) deltas.push([["scores", keys.name, "sum"], score.value]);
  } else if (keys.label) {
    deltas.push([["scores", keys.name, "values", keys.label], 1]);
  }
  return deltas;
}

/** Firestore `set(..., { merge: true })` payload of nested increments, signed; repeated paths are summed. */
export function statsIncrements(deltas: Delta[], sign: 1 | -1): Record<string, unknown> {
  const summed = new Map<string, { path: string[]; amount: number }>();
  for (const [path, amount] of deltas) {
    const key = path.join("\0");
    const entry = summed.get(key) ?? { path, amount: 0 };
    entry.amount += amount;
    summed.set(key, entry);
  }
  const doc: Record<string, unknown> = {};
  for (const { path, amount } of summed.values()) {
    let node = doc;
    for (const segment of path.slice(0, -1)) {
      node = (node[segment] ??= {}) as Record<string, unknown>;
    }
    node[path[path.length - 1]] = FieldValue.increment(sign * amount);
  }
  doc.updatedAt = FieldValue.serverTimestamp();
  return doc;
}

/** Plain-object counterpart of `statsIncrements`, for rebuilding a day in memory. */
export function applyDeltas(
  doc: Record<string, unknown>,
  deltas: Delta[],
  sign: 1 | -1,
): Record<string, unknown> {
  for (const [path, amount] of deltas) {
    let node = doc;
    for (const segment of path.slice(0, -1)) {
      node = (node[segment] ??= {}) as Record<string, unknown>;
    }
    const last = path[path.length - 1];
    node[last] = ((node[last] as number | undefined) ?? 0) + sign * amount;
  }
  return doc;
}

/** Shape of one day document as read back (every field optional on disk). */
export interface StatsDayDoc {
  traces?: number;
  errors?: number;
  spans?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMsSum?: number;
  hours?: Record<
    string,
    { traces?: number; errors?: number; costUsd?: number; totalTokens?: number }
  >;
  byModel?: Record<
    string,
    { traces?: number; inputTokens?: number; outputTokens?: number; costUsd?: number }
  >;
  byName?: Record<
    string,
    { traces?: number; errors?: number; durationMsSum?: number; hist?: Record<string, number> }
  >;
  scores?: Record<string, { count?: number; sum?: number; values?: Record<string, number> }>;
}
