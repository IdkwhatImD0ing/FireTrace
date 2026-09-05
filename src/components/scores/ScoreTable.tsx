import Link from "next/link";
import type { Score } from "@/lib/firetrace/types";
import { formatDateTime, formatScoreValue, truncateId } from "@/lib/format";

export function ScoreTable({ projectId, scores }: { projectId: string; scores: Score[] }) {
  return (
    <div className="card overflow-x-auto">
      <table className="table-dense w-full min-w-[800px] border-collapse">
        <thead>
          <tr>
            <th scope="col">Created (UTC)</th>
            <th scope="col">Name</th>
            <th scope="col" className="text-right">
              Value
            </th>
            <th scope="col">Source</th>
            <th scope="col">Comment</th>
            <th scope="col">Trace</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s) => (
            <tr key={s.id}>
              <td className="font-mono text-[11px] whitespace-nowrap text-ink-2">
                {formatDateTime(s.createdAt)}
              </td>
              <td className="font-mono text-xs text-ink">{s.name}</td>
              <td className="text-right font-mono text-xs text-ink tabular-nums">
                {formatScoreValue(s.value)}
              </td>
              <td>
                <span className="chip">{s.source}</span>
              </td>
              <td className="max-w-[24rem]">
                <span className="block truncate text-sm text-ink-2" title={s.comment ?? undefined}>
                  {s.comment ?? "—"}
                </span>
              </td>
              <td>
                <Link
                  href={`/projects/${projectId}/traces/${s.traceId}`}
                  className="font-mono text-[11px] text-ink hover:underline"
                  title={s.traceId}
                >
                  {truncateId(s.traceId)}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
