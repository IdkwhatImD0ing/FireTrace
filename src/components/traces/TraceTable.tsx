import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import type { TraceSummary } from "@/lib/firetrace/types";
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatScoreValue,
  formatTokens,
  totalTokens,
} from "@/lib/format";

export function TraceTable({
  projectId,
  traces,
  listQuery = "",
}: {
  projectId: string;
  traces: TraceSummary[];
  /** Query string of the list view, so the trace page can offer newer/older links. */
  listQuery?: string;
}) {
  return (
    <div className="card overflow-x-auto">
      <table className="table-dense w-full min-w-[960px] border-collapse">
        <thead>
          <tr>
            <th scope="col">Started (UTC)</th>
            <th scope="col">Trace</th>
            <th scope="col">Status</th>
            <th scope="col" className="text-right">
              Duration
            </th>
            <th scope="col">Model</th>
            <th scope="col" className="text-right">
              Tokens
            </th>
            <th scope="col" className="text-right">
              Cost
            </th>
            <th scope="col">Session / user</th>
            <th scope="col">Tags</th>
            <th scope="col">Scores</th>
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => {
            const scores = Object.entries(t.scores);
            return (
              <tr key={t.id}>
                <td className="font-mono text-[11px] whitespace-nowrap text-ink-2">
                  {formatDateTime(t.startedAt)}
                </td>
                <td className="max-w-[18rem]">
                  <Link
                    href={`/projects/${projectId}/traces/${t.id}${listQuery}`}
                    className="block truncate font-medium text-ink hover:underline"
                  >
                    {t.name}
                  </Link>
                  <span className="block truncate font-mono text-[10px] text-ink-3">{t.id}</span>
                </td>
                <td>
                  <StatusBadge status={t.status} />
                  {t.errorCount > 0 && (
                    <span className="ml-2 font-mono text-[10px] text-crit-2">
                      {t.errorCount} span err
                    </span>
                  )}
                </td>
                <td className="text-right font-mono text-xs text-ink-2 tabular-nums">
                  {formatDuration(t.durationMs)}
                </td>
                <td
                  className="max-w-[10rem] truncate font-mono text-xs text-ink-2"
                  title={t.model ?? undefined}
                >
                  {t.model ?? "—"}
                </td>
                <td className="text-right font-mono text-xs text-ink-2 tabular-nums">
                  {formatTokens(totalTokens(t.usage))}
                </td>
                <td className="text-right font-mono text-xs text-ink-2 tabular-nums">
                  {formatCost(t.costUsd)}
                </td>
                <td className="max-w-[12rem] font-mono text-[11px] text-ink-2">
                  {t.sessionId ? (
                    <Link
                      href={`/projects/${projectId}?sessionId=${encodeURIComponent(t.sessionId)}`}
                      className="block truncate hover:underline"
                      title={`Only session ${t.sessionId}`}
                    >
                      {t.sessionId}
                    </Link>
                  ) : (
                    <span className="block">—</span>
                  )}
                  {t.userId ? (
                    <Link
                      href={`/projects/${projectId}?userId=${encodeURIComponent(t.userId)}`}
                      className="block truncate text-ink-3 hover:underline"
                      title={`Only user ${t.userId}`}
                    >
                      {t.userId}
                    </Link>
                  ) : (
                    <span className="block text-ink-3">—</span>
                  )}
                </td>
                <td>
                  <span className="flex max-w-[14rem] flex-wrap gap-1">
                    {t.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="chip">
                        {tag}
                      </span>
                    ))}
                    {t.tags.length > 4 && <span className="chip">+{t.tags.length - 4}</span>}
                  </span>
                </td>
                <td>
                  {scores.length === 0 ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    <span className="flex max-w-[16rem] flex-wrap gap-1">
                      {scores.slice(0, 3).map(([name, s]) => (
                        <span
                          key={name}
                          className="chip font-mono"
                          title={`${name} = ${formatScoreValue(s.value)}`}
                        >
                          {name}={formatScoreValue(s.value)}
                        </span>
                      ))}
                      {scores.length > 3 && <span className="chip">+{scores.length - 3}</span>}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
