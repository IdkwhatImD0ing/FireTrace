import type { ModelRow, NameRow, ScoreRow } from "@/lib/firetrace/stats";
import { formatCost, formatDuration, formatScoreValue, formatTokens } from "@/lib/format";

const ms = (v: number | null) => (v === null ? "—" : formatDuration(Math.round(v)));

/** Trace names by volume with error counts and approximate latency percentiles. */
export function NameTable({ rows }: { rows: NameRow[] }) {
  return (
    <section className="card overflow-x-auto" aria-labelledby="names-title">
      <h2 id="names-title" className="mono-label px-4 pt-4">
        Traces by name · latency percentiles
      </h2>
      <table className="table-dense mt-2 w-full min-w-[720px] border-collapse">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="text-right">
              Traces
            </th>
            <th scope="col" className="text-right">
              Errors
            </th>
            <th scope="col" className="text-right">
              Avg
            </th>
            <th scope="col" className="text-right">
              p50
            </th>
            <th scope="col" className="text-right">
              p90
            </th>
            <th scope="col" className="text-right">
              p95
            </th>
            <th scope="col" className="text-right">
              p99
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name ?? "_other"}>
              <td
                className="max-w-[18rem] truncate font-mono text-xs text-ink"
                title={r.name ?? undefined}
              >
                {r.name ?? <span className="text-ink-3">(other names)</span>}
              </td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">{r.traces}</td>
              <td
                className={`text-right font-mono text-xs tabular-nums ${r.errors ? "text-crit-2" : "text-ink-3"}`}
              >
                {r.errors}
              </td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">
                {ms(r.avgMs)}
              </td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">{ms(r.p50)}</td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">{ms(r.p90)}</td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">{ms(r.p95)}</td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">{ms(r.p99)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-3 font-mono text-[10px] text-ink-3">
        Percentiles come from half-octave latency buckets: within about ±19% of the exact value.
      </p>
    </section>
  );
}

/** Cost and tokens per model, most expensive first. */
export function ModelTable({ rows }: { rows: ModelRow[] }) {
  return (
    <section className="card overflow-x-auto" aria-labelledby="models-title">
      <h2 id="models-title" className="mono-label px-4 pt-4">
        Cost and tokens by model
      </h2>
      <table className="table-dense mt-2 w-full min-w-[560px] border-collapse">
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col" className="text-right">
              Traces
            </th>
            <th scope="col" className="text-right">
              Input tokens
            </th>
            <th scope="col" className="text-right">
              Output tokens
            </th>
            <th scope="col" className="text-right">
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model ?? "_other"}>
              <td
                className="max-w-[18rem] truncate font-mono text-xs text-ink"
                title={r.model ?? undefined}
              >
                {r.model ?? <span className="text-ink-3">(no model)</span>}
              </td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">{r.traces}</td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">
                {formatTokens(r.inputTokens)}
              </td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">
                {formatTokens(r.outputTokens)}
              </td>
              <td className="text-right font-mono text-xs text-ink tabular-nums">
                {formatCost(r.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Per-name score summary over the range: average for numeric, label counts otherwise. */
export function ScoreStatsTable({ rows }: { rows: ScoreRow[] }) {
  return (
    <section className="card overflow-x-auto" aria-labelledby="score-stats-title">
      <h2 id="score-stats-title" className="mono-label px-4 pt-4">
        Scores
      </h2>
      <table className="table-dense mt-2 w-full min-w-[480px] border-collapse">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="text-right">
              Count
            </th>
            <th scope="col" className="text-right">
              Average
            </th>
            <th scope="col">Values</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name ?? "_other"}>
              <td className="font-mono text-xs text-ink">
                {r.name ?? <span className="text-ink-3">(other names)</span>}
              </td>
              <td className="text-right font-mono text-xs text-ink-2 tabular-nums">{r.count}</td>
              <td className="text-right font-mono text-xs text-ink tabular-nums">
                {r.average === null ? "—" : formatScoreValue(r.average)}
              </td>
              <td>
                <span className="flex flex-wrap gap-1">
                  {r.values.slice(0, 6).map((v) => (
                    <span key={v.label ?? "_other"} className="chip font-mono">
                      {v.label ?? "(other)"}: {v.count}
                    </span>
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
