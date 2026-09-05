import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";
import { ScoreSummary } from "@/components/scores/ScoreSummary";
import { ScoreTable } from "@/components/scores/ScoreTable";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectId } from "@/lib/firetrace/ids";
import { listScores, parseScoreFilters, summarizeScores } from "@/lib/firetrace/scores";
import { getAccessibleProject } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Scores" };

/** Enough for a per-name summary without a rollup; the table pages beyond it. */
const PAGE_SIZE = 200;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function withParams(base: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

export default async function ProjectScoresPage({
  params,
  searchParams,
}: PageProps<"/projects/[projectId]/scores">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId } = await params;
  if (!isProjectId(projectId)) notFound();
  const sp = await searchParams;
  const db = adminDb();
  const project = await getAccessibleProject(db, owner, projectId);
  if (!project) notFound();

  const filters = parseScoreFilters(sp);
  const page = await listScores(db, projectId, filters, {
    after: first(sp.after),
    limit: PAGE_SIZE,
  });
  const summaries = summarizeScores(page.scores);
  const filterParams = { name: filters.name, from: filters.from, to: filters.to };
  const base = `/projects/${projectId}/scores`;
  const filtering = Object.values(filterParams).some(Boolean);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="mono-label inline-flex items-center gap-1.5 hover:text-ink-2"
        >
          <span aria-hidden>←</span> {project.name}
        </Link>
        <h1 className="mt-1 font-display text-5xl leading-none text-ink">Scores</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">
          Judgements attached to traces after the run: ratings sent by your application, verdicts
          entered on a trace page, evaluator results. The summary covers the scores shown below.
        </p>
      </div>

      <form method="get" action={base} className="card flex flex-wrap items-end gap-3 p-4">
        <label className="min-w-40">
          <span className="mono-label block">Name</span>
          <input
            name="name"
            list="score-names"
            defaultValue={filters.name ?? ""}
            className="input mt-1.5"
            placeholder="any"
          />
          <datalist id="score-names">
            {summaries.map((s) => (
              <option key={s.name} value={s.name} />
            ))}
          </datalist>
        </label>
        <label>
          <span className="mono-label block">From (UTC)</span>
          <input
            type="datetime-local"
            name="from"
            defaultValue={filters.from?.slice(0, 16) ?? ""}
            className="input mt-1.5"
          />
        </label>
        <label>
          <span className="mono-label block">To (UTC)</span>
          <input
            type="datetime-local"
            name="to"
            defaultValue={filters.to?.slice(0, 16) ?? ""}
            className="input mt-1.5"
          />
        </label>
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary">
            Apply
          </button>
          {filtering && (
            <Link href={base} className="btn btn-ghost">
              Clear
            </Link>
          )}
        </div>
      </form>

      {page.scores.length === 0 ? (
        filtering ? (
          <p className="card px-5 py-8 text-center text-sm text-ink-2">
            No scores match these filters.
          </p>
        ) : (
          <EmptyState
            title="No scores yet."
            body={
              <>
                Add one from the Scores tab of a trace page, send{" "}
                <code className="font-mono text-ink">POST /api/v1/traces/{"{traceId}"}/scores</code>{" "}
                from your application, or let an agent call{" "}
                <code className="font-mono text-ink">add_score</code> over MCP.
              </>
            }
          />
        )
      ) : (
        <>
          <ScoreSummary summaries={summaries} />
          <ScoreTable projectId={projectId} scores={page.scores} />
          <nav aria-label="Pagination" className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-ink-3">
              {page.scores.length} of up to {page.pageSize} per page · newest first
            </span>
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
          </nav>
        </>
      )}
    </div>
  );
}
