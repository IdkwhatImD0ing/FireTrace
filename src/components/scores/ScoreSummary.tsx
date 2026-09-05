import type { ScoreNameSummary } from "@/lib/firetrace/scores";
import { formatScoreValue } from "@/lib/format";

/** One card per score name: the average for numeric scores, the value counts otherwise. */
export function ScoreSummary({ summaries }: { summaries: ScoreNameSummary[] }) {
  if (summaries.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {summaries.map((s) => (
        <div key={s.name} className="card p-4">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-mono text-sm text-ink" title={s.name}>
              {s.name}
            </span>
            <span className="chip shrink-0">{s.dataType}</span>
          </div>
          <p className="mt-2 font-mono text-2xl text-ink">
            {s.average !== null ? formatScoreValue(s.average) : s.count}
          </p>
          <p className="mono-label mt-0.5">
            {s.average !== null
              ? `average of ${s.count}`
              : `${s.count} score${s.count === 1 ? "" : "s"}`}
          </p>
          {s.values.length > 0 && (
            <ul className="mt-2 space-y-1">
              {s.values.slice(0, 5).map((v) => (
                <li
                  key={v.label}
                  className="flex items-center justify-between gap-2 font-mono text-[11px] text-ink-2"
                >
                  <span className="truncate" title={v.label}>
                    {v.label}
                  </span>
                  <span className="text-ink-3 tabular-nums">{v.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
