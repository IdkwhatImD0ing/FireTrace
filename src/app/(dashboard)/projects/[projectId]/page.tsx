import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { TrialNotice } from "@/components/dashboard/TrialNotice";
import { SetupPanel } from "@/components/traces/SetupPanel";
import { StorageNotice } from "@/components/traces/StorageNotice";
import { TraceFilters } from "@/components/traces/TraceFilters";
import { TraceTable } from "@/components/traces/TraceTable";
import { serverEnv } from "@/lib/env/server";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectId } from "@/lib/firetrace/ids";
import { listApiKeys } from "@/lib/firetrace/projects";
import { effectivePlan, getTrialUsage, trialSubject } from "@/lib/firetrace/trial";
import { listTraces, parseTraceFilters, recentModels } from "@/lib/firetrace/queries";
import { formatBytes } from "@/lib/firetrace/storage";
import { getAccessibleProject } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Traces" };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function withParams(base: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

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
  const trial =
    effectivePlan(project, env.allowedEmails) === "trial"
      ? await getTrialUsage(db, trialSubject(project.ownerEmail ?? project.ownerUid))
      : null;

  const filters = parseTraceFilters(sp);
  const after = first(sp.after);
  const before = first(sp.before);
  const [page, keys, models] = await Promise.all([
    listTraces(db, projectId, filters, { after, before }),
    listApiKeys(db, projectId),
    recentModels(db, projectId),
  ]);

  const filterParams = {
    status: filters.status,
    model: filters.model,
    sessionId: filters.sessionId,
    userId: filters.userId,
    from: filters.from,
    to: filters.to,
  };
  const base = `/projects/${projectId}`;
  const filtering = Object.values(filterParams).some(Boolean);

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
          </p>
        </div>
        <Link href={`${base}/settings`} className="btn btn-ghost">
          Settings
        </Link>
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
          <TraceFilters projectId={projectId} filters={filters} models={models} />
          {page.traces.length === 0 ? (
            <p className="card px-5 py-8 text-center text-sm text-ink-2">
              No traces match these filters.
            </p>
          ) : (
            <TraceTable projectId={projectId} traces={page.traces} />
          )}
          <nav aria-label="Pagination" className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-ink-3">
              {page.traces.length} of up to {page.pageSize} per page · newest first
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
