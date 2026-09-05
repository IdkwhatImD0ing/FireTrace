import Link from "next/link";
import type { EvalRun } from "@/lib/eval/schema";
import { formatDateTime, formatDuration, formatTokens, truncateId } from "@/lib/format";

const STATUS_TONE: Record<EvalRun["status"], string> = {
  ok: "text-good",
  failed: "text-crit-2",
  running: "text-warn",
};

/** The run log: one row per attempt that reached the judge, newest first. */
export function EvalRunsTable({ projectId, runs }: { projectId: string; runs: EvalRun[] }) {
  return (
    <section className="space-y-3" aria-labelledby="runs-title">
      <div>
        <h2 id="runs-title" className="font-display text-2xl text-ink">
          Recent runs
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          Every call to the judge, with its tokens, so the cost of evaluating stays visible. Failed
          runs write no score.
        </p>
      </div>
      {runs.length === 0 ? (
        <p className="card px-5 py-8 text-center text-sm text-ink-2">No runs yet.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="table-dense w-full min-w-[900px] border-collapse">
            <thead>
              <tr>
                <th scope="col">When (UTC)</th>
                <th scope="col">Evaluator</th>
                <th scope="col">Trace</th>
                <th scope="col">Trigger</th>
                <th scope="col">Status</th>
                <th scope="col">Model</th>
                <th scope="col" className="text-right">
                  Tokens
                </th>
                <th scope="col" className="text-right">
                  Duration
                </th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-[11px] whitespace-nowrap text-ink-2">
                    {formatDateTime(r.createdAt)}
                  </td>
                  <td className="font-mono text-xs text-ink">{r.evaluatorName}</td>
                  <td>
                    <Link
                      href={`/projects/${projectId}/traces/${r.traceId}`}
                      className="font-mono text-[11px] text-ink hover:underline"
                      title={r.traceId}
                    >
                      {truncateId(r.traceId)}
                    </Link>
                  </td>
                  <td className="font-mono text-[11px] text-ink-2">{r.trigger}</td>
                  <td className={`font-mono text-[11px] uppercase ${STATUS_TONE[r.status]}`}>
                    {r.status}
                  </td>
                  <td
                    className="max-w-[10rem] truncate font-mono text-xs text-ink-2"
                    title={r.model ?? undefined}
                  >
                    {r.model ?? "—"}
                  </td>
                  <td className="text-right font-mono text-xs text-ink-2 tabular-nums">
                    {r.usage?.totalTokens !== undefined ? formatTokens(r.usage.totalTokens) : "—"}
                  </td>
                  <td className="text-right font-mono text-xs text-ink-2 tabular-nums">
                    {r.durationMs === null ? "—" : formatDuration(r.durationMs)}
                  </td>
                  <td className="max-w-[20rem]">
                    <span
                      className="block truncate text-xs text-crit-2"
                      title={r.error ?? undefined}
                    >
                      {r.error ?? ""}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
