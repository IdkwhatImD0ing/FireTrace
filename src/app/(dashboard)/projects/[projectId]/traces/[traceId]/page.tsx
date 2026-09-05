import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { StatusBadge } from "@/components/StatusBadge";
import { DeleteTraceButton } from "@/components/trace/DeleteTraceButton";
import { RunEvaluatorButton } from "@/components/trace/RunEvaluatorButton";
import { ScoresPanel } from "@/components/trace/ScoresPanel";
import { TraceExplorer } from "@/components/trace/TraceExplorer";
import { TraceNav } from "@/components/trace/TraceNav";
import { serverEnv } from "@/lib/env/server";
import { getEnvironmentView } from "@/lib/environment-selection";
import { listEvaluators } from "@/lib/eval/evaluators";
import { adminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/firetrace/errors";
import { isProjectId, isTraceId } from "@/lib/firetrace/ids";
import {
  cursorFor,
  listSpans,
  listTraces,
  parseTraceFilters,
  parseTraceSort,
  traceListQuery,
} from "@/lib/firetrace/queries";
import { listScoresForTrace } from "@/lib/firetrace/scores";
import type { TraceDetail, TraceFilters, TraceSort } from "@/lib/firetrace/types";
import { getAccessibleProject, getAccessibleTrace } from "@/lib/auth/access";
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

/**
 * Newer / older links in the list's current order. Streams in after the rest
 * of the page (two more list queries), rendering disabled until then.
 */
async function TraceNeighbours({
  projectId,
  trace,
  filters,
  sort,
  listQuery,
}: {
  projectId: string;
  trace: TraceDetail;
  filters: TraceFilters;
  sort: TraceSort;
  listQuery: string;
}) {
  const db = adminDb();
  let older: string | null = null;
  let newer: string | null = null;
  try {
    const [after, before] = await Promise.all([
      listTraces(db, projectId, filters, { after: cursorFor(trace, sort), limit: 1, sort }),
      listTraces(db, projectId, filters, { before: cursorFor(trace, sort), limit: 1, sort }),
    ]);
    older = after.traces[0]?.id ?? null;
    newer = before.traces[0]?.id ?? null;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
  }
  const href = (id: string | null) =>
    id ? `/projects/${projectId}/traces/${id}${listQuery}` : null;
  return <TraceNav newerHref={href(newer)} olderHref={href(older)} />;
}

export default async function TracePage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/traces/[traceId]">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId, traceId } = await params;
  if (!isProjectId(projectId) || !isTraceId(traceId)) notFound();
  // The list view this trace was opened from, so newer/older follow the same order.
  const sp = await searchParams;
  const sort = parseTraceSort(sp.sort);
  const listQuery = traceListQuery(parseTraceFilters(sp), sort);
  const db = adminDb();
  const project = await getAccessibleProject(db, owner, projectId);
  if (!project) notFound();
  const isOwner = owner.role === "owner";
  // Everything below needs only the authorized project, so it is one round trip.
  // The trace read is shared with the layout, which already 404s when it is missing.
  const [trace, spans, scores, evaluators, view] = await Promise.all([
    getAccessibleTrace(db, owner, projectId, traceId),
    listSpans(db, projectId, traceId),
    listScoresForTrace(db, projectId, traceId),
    isOwner ? listEvaluators(db, projectId) : Promise.resolve([]),
    getEnvironmentView(db, projectId),
  ]);
  if (!trace) notFound();
  // Neighbours stay inside the selected environment, like the list did.
  const filters = { ...parseTraceFilters(sp), environment: view.filter };
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
            <Suspense fallback={<TraceNav newerHref={null} olderHref={null} />}>
              <TraceNeighbours
                projectId={projectId}
                trace={trace}
                filters={filters}
                sort={sort}
                listQuery={listQuery}
              />
            </Suspense>
            <DeleteTraceButton projectId={projectId} traceId={traceId} traceName={trace.name} />
          </div>
        </div>
      </div>

      <dl className="card grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-4 xl:grid-cols-9">
        <div>
          <dt className="mono-label">status</dt>
          <dd className="mt-0.5">
            <StatusBadge status={trace.status} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="mono-label">environment</dt>
          <dd
            className="mt-0.5 truncate font-mono text-sm text-ink"
            title="Set by the key that recorded this trace"
          >
            {trace.environment ?? <span className="text-ink-3">unassigned</span>}
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
