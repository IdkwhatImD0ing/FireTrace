import Link from "next/link";
import { StatusBadge } from "@/components/StatusBadge";
import type { TraceSummary } from "@/lib/firetrace/types";
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  totalTokens,
} from "@/lib/format";

export function TraceTable({ projectId, traces }: { projectId: string; traces: TraceSummary[] }) {
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
          </tr>
        </thead>
        <tbody>
          {traces.map((t) => (
            <tr key={t.id}>
              <td className="font-mono text-[11px] whitespace-nowrap text-ink-2">
                {formatDateTime(t.startedAt)}
              </td>
              <td className="max-w-[18rem]">
                <Link
                  href={`/projects/${projectId}/traces/${t.id}`}
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
                <span className="block truncate" title={t.sessionId ?? undefined}>
                  {t.sessionId ?? "—"}
                </span>
                <span className="block truncate text-ink-3" title={t.userId ?? undefined}>
                  {t.userId ?? "—"}
                </span>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
