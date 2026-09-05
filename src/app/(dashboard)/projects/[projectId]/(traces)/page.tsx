import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { TrialNotice } from "@/components/dashboard/TrialNotice";
import { RunEvaluatorBulk } from "@/components/traces/RunEvaluatorBulk";
import { SessionSummary } from "@/components/traces/SessionSummary";
import { SetupPanel } from "@/components/traces/SetupPanel";
import { StorageNotice } from "@/components/traces/StorageNotice";
import { TraceFilters } from "@/components/traces/TraceFilters";
import { TraceHistogram } from "@/components/traces/TraceHistogram";
import { TraceTable } from "@/components/traces/TraceTable";
import { serverEnv } from "@/lib/env/server";
import { getEnvironmentView, listProjectApiKeys } from "@/lib/environment-selection";
import { listEvaluators } from "@/lib/eval/evaluators";
import { EVAL_LIMITS } from "@/lib/eval/schema";
import { adminDb } from "@/lib/firebase/admin";
import { ApiError } from "@/lib/firetrace/errors";
import { isProjectId } from "@/lib/firetrace/ids";
import { effectivePlan, getTrialUsage, trialSubject } from "@/lib/firetrace/trial";
import {
  DEFAULT_PAGE_SIZE,
  listTraces,
  parseTraceFilters,
  parseTraceSort,
  recentFacets,
  traceListQuery,
} from "@/lib/firetrace/queries";
import { getProjectStats } from "@/lib/firetrace/stats";
import { formatBytes } from "@/lib/firetrace/storage";
import type { TracePage, TraceSort } from "@/lib/firetrace/types";
import { getAccessibleProject } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";
import { firstParam, withParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "Traces" };
/** Bulk evaluator runs are server actions on this route; up to 50 judge calls. */
export const maxDuration = 300;

const SORT_LABEL: Record<TraceSort, string> = {
  newest: "newest first",
  slowest: "slowest first",
  costliest: "costliest first",
};

const EMPTY_PAGE: TracePage = {
  traces: [],
  nextCursor: null,
  prevCursor: null,
  pageSize: DEFAULT_PAGE_SIZE,
};

export default async function ProjectTracesPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId } = await params;
  if (!isProjectId(projectId)) notFound();
  const sp = await searchParams;
  const env = serverEnv();
  const db = adminDb();
  const project = await getAccessibleProject(db, owner, projectId);
  if (!project) notFound();

  // URL filters drive the form and the links; the environment comes from the
  // selector's cookie and is applied to every query on top of them.
  const view = await getEnvironmentView(db, projectId);
  const urlFilters = parseTraceFilters(sp);
  const filters = { ...urlFilters, environment: view.filter };
  const sort = parseTraceSort(sp.sort);
  const after = firstParam(sp.after);
  const before = firstParam(sp.before);
  const isOwner = owner.role === "owner";
  const filterParams = {
    status: filters.status,
    model: filters.model,
    name: filters.name,
    tag: filters.tag,
    sessionId: filters.sessionId,
    userId: filters.userId,
    from: filters.from,
    to: filters.to,
    sort: sort === "newest" ? undefined : sort,
  };
  const base = `/projects/${projectId}`;
  const filtering = Object.values(filterParams).some(Boolean);
  const listQuery = traceListQuery(filters, sort);
  const showList = project.traceCount > 0 || filtering;

  const loadList = async (): Promise<{ page: TracePage; listError: string | null }> => {
    try {
      const page = await listTraces(db, projectId, filters, { after, before, sort });
      return { page, listError: null };
    } catch (err) {
      // A sort that does not combine with the chosen filters: say so instead of a 500.
      if (!(err instanceof ApiError) || err.status !== 400) throw err;
      return { page: EMPTY_PAGE, listError: err.message };
    }
  };
  // Everything below needs only the authorized project, so it is one round trip.
  const [trial, keys, facets, evaluators, { page, listError }, stats] = await Promise.all([
    effectivePlan(project, env.allowedEmails) === "trial"
      ? getTrialUsage(db, trialSubject(project.ownerEmail ?? project.ownerUid))
      : null,
    listProjectApiKeys(db, projectId),
    recentFacets(db, projectId),
    isOwner ? listEvaluators(db, projectId) : Promise.resolve([]),
    loadList(),
    showList ? getProjectStats(db, projectId, "14d", view.filter) : null,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/projects"
            className="mono-label inline-flex items-center gap-1.5 hover:text-ink-2"
          >
            <span aria-hidden>←</span> projects
          </Link>
          <h1 className="mt-1 truncate font-display text-5xl leading-none text-ink">
            {project.name}
          </h1>
          <p className="mt-2 font-mono text-[11px] text-ink-3">
            {project.traceCount.toLocaleString("en-US")} traces ·{" "}
            {project.spanCount.toLocaleString("en-US")} spans · est.{" "}
            {formatBytes(project.estimatedBytes)}
            {view.filter && " · these counts cover every environment"}
          </p>
        </div>
      </div>

      <StorageNotice estimatedBytes={project.estimatedBytes} limitBytes={env.storageLimitBytes} />

      {trial && (
        <TrialNotice
          used={trial.tracesUsed}
          limit={env.trialTraceLimit}
          repositoryUrl={env.repositoryUrl}
          viewer={owner.role}
          ownerEmail={project.ownerEmail}
        />
      )}

      {project.traceCount === 0 && !filtering ? (
        <>
          <EmptyState
            title="No traces recorded yet."
            body="Create an API key in settings, then send a completed run from your application. It appears here on the next page load."
          />
          <SetupPanel projectId={projectId} appUrl={env.appUrl} keys={keys} />
        </>
      ) : (
        <>
          <TraceFilters projectId={projectId} filters={urlFilters} facets={facets} sort={sort} />
          {stats && <TraceHistogram projectId={projectId} stats={stats} />}
          {(filters.sessionId || filters.userId) && page.traces.length > 0 && (
            <SessionSummary filters={urlFilters} traces={page.traces} />
          )}
          {isOwner && evaluators.length > 0 && page.traces.length > 0 && (
            <RunEvaluatorBulk
              projectId={projectId}
              evaluators={evaluators.map((e) => ({ id: e.id, name: e.name }))}
              filters={filterParams}
              traceCount={page.traces.length}
              maxTraces={EVAL_LIMITS.maxBulkTraces}
              configured={env.eval !== null}
            />
          )}
          {page.traces.length === 0 ? (
            <p className="card px-5 py-8 text-center text-sm text-ink-2">
              {listError ??
                (view.filter
                  ? `No ${view.selection} traces match these filters.`
                  : "No traces match these filters.")}
            </p>
          ) : (
            <TraceTable projectId={projectId} traces={page.traces} listQuery={listQuery} />
          )}
          <nav aria-label="Pagination" className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-ink-3">
              {page.traces.length} of up to {page.pageSize} per page · {SORT_LABEL[sort]} ·{" "}
              <a
                href={withParams(`/api/projects/${projectId}/traces/export`, {
                  ...filterParams,
                  after,
                  before,
                })}
                className="text-ink hover:underline"
                download={`firetrace-${projectId}-traces.csv`}
              >
                Export CSV
              </a>
            </span>
            <div className="flex gap-2">
              {page.prevCursor ? (
                <Link
                  href={withParams(base, { ...filterParams, before: page.prevCursor })}
                  className="btn btn-ghost btn-sm"
                >
                  ← Newer
                </Link>
              ) : (
                <span className="btn btn-ghost btn-sm opacity-40" aria-disabled>
                  ← Newer
                </span>
              )}
              {page.nextCursor ? (
                <Link
                  href={withParams(base, { ...filterParams, after: page.nextCursor })}
                  className="btn btn-ghost btn-sm"
                >
                  Older →
                </Link>
              ) : (
                <span className="btn btn-ghost btn-sm opacity-40" aria-disabled>
                  Older →
                </span>
              )}
            </div>
          </nav>
          <details className="card p-5">
            <summary className="cursor-pointer font-display text-xl text-ink">
              Setup: endpoint, key and agent prompt
            </summary>
            <div className="mt-4">
              <SetupPanel projectId={projectId} appUrl={env.appUrl} keys={keys} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}
