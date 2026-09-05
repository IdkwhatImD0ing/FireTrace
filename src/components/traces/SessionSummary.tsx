import type { TraceFilters, TraceSummary } from "@/lib/firetrace/types";
import { formatCost, formatDateTime, formatTokens, totalTokens } from "@/lib/format";

/** Totals for the page of traces shown while a session or user filter is active. */
export function SessionSummary({
  filters,
  traces,
}: {
  filters: TraceFilters;
  traces: TraceSummary[];
}) {
  const errors = traces.filter((t) => t.status === "error").length;
  const cost = traces.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const tokens = traces.reduce((sum, t) => sum + (totalTokens(t.usage) ?? 0), 0);
  const times = traces.map((t) => Date.parse(t.startedAt));
  const first = new Date(Math.min(...times)).toISOString();
  const last = new Date(Math.max(...times)).toISOString();
  const facts: Array<[string, string]> = [
    ...(filters.sessionId ? [["session", filters.sessionId] as [string, string]] : []),
    ...(filters.userId ? [["user", filters.userId] as [string, string]] : []),
    ["traces on this page", `${traces.length}${errors ? ` · ${errors} with errors` : ""}`],
    ["first (UTC)", formatDateTime(first)],
    ["last (UTC)", formatDateTime(last)],
    ["cost", formatCost(cost)],
    ["tokens", formatTokens(tokens)],
  ];
  return (
    <dl className="card flex flex-wrap gap-x-6 gap-y-2 px-5 py-3" aria-label="Session summary">
      {facts.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="mono-label">{label}</dt>
          <dd className="mt-0.5 truncate font-mono text-xs text-ink" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
