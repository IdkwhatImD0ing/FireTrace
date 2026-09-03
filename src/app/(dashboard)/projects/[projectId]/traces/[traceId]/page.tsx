import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { DeleteTraceButton } from "@/components/trace/DeleteTraceButton";
import { TraceExplorer } from "@/components/trace/TraceExplorer";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectId, isTraceId } from "@/lib/firetrace/ids";
import { getTrace, listSpans } from "@/lib/firetrace/queries";
import { getAccessibleProject } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  totalTokens,
} from "@/lib/format";

export const metadata: Metadata = { title: "Trace" };

export default async function TracePage({
  params,
}: PageProps<"/projects/[projectId]/traces/[traceId]">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId, traceId } = await params;
  if (!isProjectId(projectId) || !isTraceId(traceId)) notFound();
  const db = adminDb();
  const project = await getAccessibleProject(db, owner, projectId);
  if (!project) notFound();
  const trace = await getTrace(db, projectId, traceId);
  if (!trace) notFound();
  const spans = await listSpans(db, projectId, traceId);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="mono-label inline-flex items-center gap-1.5 hover:text-ink-2"
        >
          <span aria-hidden>←</span> {project.name}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <h1 className="min-w-0 truncate font-display text-4xl leading-tight text-ink sm:text-5xl">
            {trace.name}
          </h1>
          <DeleteTraceButton projectId={projectId} traceId={traceId} traceName={trace.name} />
        </div>
      </div>

      <dl className="card grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-4 xl:grid-cols-8">
        <div>
          <dt className="mono-label">status</dt>
          <dd className="mt-0.5">
            <StatusBadge status={trace.status} />
          </dd>
        </div>
        <div>
          <dt className="mono-label">latency</dt>
          <dd className="mt-0.5 font-mono text-sm text-ink">{formatDuration(trace.durationMs)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="mono-label">model</dt>
          <dd
            className="mt-0.5 truncate font-mono text-sm text-ink"
            title={trace.model ?? undefined}
          >
            {trace.model ?? "—"}
            {trace.provider && <span className="text-ink-3"> · {trace.provider}</span>}
          </dd>
        </div>
        <div>
          <dt className="mono-label">tokens</dt>
          <dd className="mt-0.5 font-mono text-sm text-ink">
            {formatTokens(totalTokens(trace.usage))}
          </dd>
        </div>
        <div>
          <dt className="mono-label">cost</dt>
          <dd className="mt-0.5 font-mono text-sm text-ink">{formatCost(trace.costUsd)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="mono-label">started (UTC)</dt>
          <dd className="mt-0.5 truncate font-mono text-xs text-ink">
            {formatDateTime(trace.startedAt)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="mono-label">session / user</dt>
          <dd
            className="mt-0.5 truncate font-mono text-xs text-ink"
            title={`${trace.sessionId ?? "—"} / ${trace.userId ?? "—"}`}
          >
            {trace.sessionId ?? "—"} <span className="text-ink-3">/</span> {trace.userId ?? "—"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="mono-label">tags</dt>
          <dd className="mt-0.5 flex flex-wrap gap-1">
            {trace.tags.length === 0 ? (
              <span className="text-sm text-ink-3">—</span>
            ) : (
              trace.tags.map((t) => (
                <span key={t} className="chip">
                  {t}
                </span>
              ))
            )}
          </dd>
        </div>
      </dl>

      <TraceExplorer trace={trace} spans={spans} projectId={projectId} />
    </div>
  );
}
