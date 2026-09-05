import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { BarChart } from "@/components/stats/BarChart";
import { RangePicker } from "@/components/stats/RangePicker";
import { StatCard } from "@/components/stats/StatCard";
import { ModelTable, NameTable, ScoreStatsTable } from "@/components/stats/StatsTables";
import { CopyButton } from "@/components/ui/CopyButton";
import { getEnvironmentView } from "@/lib/environment-selection";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectId } from "@/lib/firetrace/ids";
import { getProjectStats, parseRange } from "@/lib/firetrace/stats";
import { getAccessibleProject } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

export default async function ProjectDashboardPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/dashboard">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId } = await params;
  if (!isProjectId(projectId)) notFound();
  const db = adminDb();
  const project = await getAccessibleProject(db, owner, projectId);
  if (!project) notFound();
  const range = parseRange((await searchParams).range);
  // Every number on this page reads the rollups of the selected environment.
  const view = await getEnvironmentView(db, projectId);
  const stats = await getProjectStats(db, projectId, range, view.filter);
  const scopeLabel = view.filter ? view.selection : "all environments";
  const base = `/projects/${projectId}/dashboard`;
  const backfill = `pnpm exec tsx scripts/backfill-stats.ts --project ${projectId} --apply`;
  const { totals } = stats;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={`/projects/${projectId}`}
            className="mono-label inline-flex items-center gap-1.5 hover:text-ink-2"
          >
            <span aria-hidden>←</span> {project.name}
          </Link>
          <h1 className="mt-1 font-display text-5xl leading-none text-ink">Dashboard</h1>
          <p className="mt-2 font-mono text-[11px] text-ink-3">
            <span className={view.filter ? "text-ember-2" : undefined}>{scopeLabel}</span> · UTC{" "}
            {stats.hourly ? "hours" : "days"} · rolled up at ingest · {stats.days} day
            {stats.days === 1 ? "" : "s"} with data in range
          </p>
        </div>
        <RangePicker base={base} range={range} />
      </div>

      {project.traceCount === 0 ? (
        <EmptyState
          title="Nothing to chart yet."
          body="Send a few traces and this page fills in: volume, errors, cost, tokens, latency percentiles and scores over time."
        >
          <Link href={`/projects/${projectId}`} className="btn btn-primary">
            Set up ingestion
          </Link>
        </EmptyState>
      ) : stats.days === 0 ? (
        <div className="card space-y-3 p-5">
          <h2 className="font-display text-2xl text-ink">
            No {view.filter ? `${view.selection} ` : ""}rollups for this range.
          </h2>
          <p className="max-w-2xl text-sm text-ink-2">
            Charts read per-day rollups, one set per environment, that FireTrace writes as traces
            arrive. Traces recorded before the dashboard or before environments existed have none,
            so either pick a wider range or rebuild the rollups once from the stored traces
            (read-only for traces; safe to repeat):
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="pre flex-1 overflow-x-auto px-3 py-2 text-xs">{backfill}</code>
            <CopyButton text={backfill} label="Copy" className="btn btn-ghost btn-sm" />
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Traces"
              value={totals.traces.toLocaleString("en-US")}
              hint={
                totals.avgMs === null
                  ? undefined
                  : `avg ${formatDuration(Math.round(totals.avgMs))}`
              }
              series={stats.series.map((p) => p.traces)}
            />
            <StatCard
              label="Error rate"
              value={totals.errorRate === null ? "—" : `${(totals.errorRate * 100).toFixed(1)}%`}
              hint={`${totals.errors.toLocaleString("en-US")} trace${totals.errors === 1 ? "" : "s"} with status error`}
              series={stats.series.map((p) => p.errors)}
            />
            <StatCard
              label="Cost"
              value={formatCost(totals.costUsd)}
              hint="from costUsd sent with each trace"
              series={stats.series.map((p) => p.costUsd)}
            />
            <StatCard
              label="Tokens"
              value={formatTokens(totals.totalTokens)}
              hint="input + output"
              series={stats.series.map((p) => p.totalTokens)}
            />
          </div>

          <BarChart
            title={`Traces per ${stats.hourly ? "hour" : "day"} · errors in red`}
            points={stats.series.map((p) => ({
              key: p.key,
              label: p.label,
              value: p.traces,
              errors: p.errors,
            }))}
            format={(v) => `${v.toLocaleString("en-US")} traces`}
          />

          <div className="grid gap-3 xl:grid-cols-2">
            <BarChart
              title={`Cost per ${stats.hourly ? "hour" : "day"}`}
              points={stats.series.map((p) => ({ key: p.key, label: p.label, value: p.costUsd }))}
              format={formatCost}
            />
            <BarChart
              title={`Tokens per ${stats.hourly ? "hour" : "day"}`}
              points={stats.series.map((p) => ({
                key: p.key,
                label: p.label,
                value: p.totalTokens,
              }))}
              format={(v) => `${formatTokens(v)} tokens`}
            />
          </div>

          {stats.byName.length > 0 && <NameTable rows={stats.byName} />}
          <div className="grid items-start gap-3 xl:grid-cols-2">
            {stats.byModel.length > 0 && <ModelTable rows={stats.byModel} />}
            {stats.scores.length > 0 && <ScoreStatsTable rows={stats.scores} />}
          </div>
        </>
      )}
    </div>
  );
}
