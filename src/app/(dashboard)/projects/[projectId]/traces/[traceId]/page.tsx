import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/StatusBadge";
import { DeleteTraceButton } from "@/components/trace/DeleteTraceButton";
import { RunEvaluatorButton } from "@/components/trace/RunEvaluatorButton";
import { ScoresPanel } from "@/components/trace/ScoresPanel";
import { TraceExplorer } from "@/components/trace/TraceExplorer";
import { TraceNav } from "@/components/trace/TraceNav";
import { serverEnv } from "@/lib/env/server";
import { listEvaluators } from "@/lib/eval/evaluators";
import { adminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/firetrace/errors";
import { isProjectId, isTraceId } from "@/lib/firetrace/ids";
import {
  cursorFor,
  getTrace,
  listSpans,
  listTraces,
  parseTraceFilters,
  parseTraceSort,
  traceListQuery,
} from "@/lib/firetrace/queries";
import { listScoresForTrace } from "@/lib/firetrace/scores";
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
/** "Run evaluator" is a server action on this route; the judge may take a while. */
export const maxDuration = 300;

export default async function TracePage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/traces/[traceId]">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId, traceId } = await params;
  if (!isProjectId(projectId) || !isTraceId(traceId)) notFound();
  // The list view this trace was opened from, so newer/older follow the same order.
  const sp = await searchParams;
  const filters = parseTraceFilters(sp);
  const sort = parseTraceSort(sp.sort);
  const listQuery = traceListQuery(filters, sort);
  const db = adminDb();
  const project = await getAccessibleProject(db, owner, projectId);
  if (!project) notFound();
  const trace = await getTrace(db, projectId, traceId);
  if (!trace) notFound();
  const isOwner = owner.role === "owner";
  const neighbours = async () => {
    try {
      const [older, newer] = await Promise.all([
        listTraces(db, projectId, filters, { after: cursorFor(trace, sort), limit: 1, sort }),
        listTraces(db, projectId, filters, { before: cursorFor(trace, sort), limit: 1, sort }),
      ]);
      return { older: older.traces[0]?.id ?? null, newer: newer.traces[0]?.id ?? null };
    } catch (err) {
      if (err instanceof ApiError) return { older: null, newer: null };
      throw err;
    }
  };
  const [spans, scores, evaluators, next] = await Promise.all([
    listSpans(db, projectId, traceId),
    listScoresForTrace(db, projectId, traceId),
    isOwner ? listEvaluators(db, projectId) : Promise.resolve([]),
    neighbours(),
  ]);
  const traceHref = (id: string) => `/projects/${projectId}/traces/${id}${listQuery}`;
  const evalConfigured = serverEnv().eval !== null;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/projects/${projectId}${listQuery}`}
          className="mono-label inline-flex items-center gap-1.5 hover:text-ink-2"
        >
          <span aria-hidden>←</span> {project.name}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <h1 className="min-w-0 truncate font-display text-4xl leading-tight text-ink sm:text-5xl">
            {trace.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <TraceNav
              newerHref={next.newer ? traceHref(next.newer) : null}
              olderHref={next.older ? traceHref(next.older) : null}
            />
            <DeleteTraceButton projectId={projectId} traceId={traceId} traceName={trace.name} />
          </div>
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

      <TraceExplorer
        trace={trace}
        spans={spans}
        projectId={projectId}
        scoresTab={{
          badge: scores.length || undefined,
          content: (
            <>
              {isOwner && (
                <RunEvaluatorButton
                  projectId={projectId}
                  traceId={traceId}
                  evaluators={evaluators.map((e) => ({ id: e.id, name: e.name }))}
                  configured={evalConfigured}
                />
              )}
              <ScoresPanel projectId={projectId} traceId={traceId} scores={scores} />
            </>
          ),
        }}
      />
    </div>
  );
}
