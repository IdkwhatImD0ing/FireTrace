import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";
import { TrialNotice } from "@/components/dashboard/TrialNotice";
import { CreateProjectDialog } from "@/components/projects/CreateProjectDialog";
import { serverEnv } from "@/lib/env/server";
import { adminDb } from "@/lib/firebase/admin";
import { getTrialUsage, TRIAL_MAX_PROJECTS, trialSubject } from "@/lib/firetrace/trial";
import { formatBytes, percentOfLimit, storageLevel } from "@/lib/firetrace/storage";
import { formatDateTime } from "@/lib/format";
import { listProjectsFor } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const owner = await requireOwnerOrRedirect();
  const env = serverEnv();
  const db = adminDb();
  const projects = await listProjectsFor(db, owner);
  const trial = owner.role === "trial" ? await getTrialUsage(db, trialSubject(owner.email)) : null;
  const canCreate = owner.role === "owner" || projects.length < TRIAL_MAX_PROJECTS;
  const totalBytes = projects.reduce((sum, p) => sum + p.estimatedBytes, 0);
  const level = storageLevel(totalBytes, env.storageLimitBytes);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mono-label">Trace namespaces</p>
          <h1 className="mt-1 font-display text-5xl leading-none text-ink">Projects</h1>
        </div>
        {projects.length > 0 && canCreate && <CreateProjectDialog primary />}
      </div>

      {trial && (
        <TrialNotice
          used={trial.tracesUsed}
          limit={env.trialTraceLimit}
          repositoryUrl={env.repositoryUrl}
          viewer="trial"
        />
      )}

      {level !== "ok" && (
        <p
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            level === "critical"
              ? "border-crit/50 bg-crit/10 text-ink"
              : "border-warn/50 bg-warn/10 text-ink"
          }`}
        >
          Estimated storage across projects is {formatBytes(totalBytes)} (
          {percentOfLimit(totalBytes, env.storageLimitBytes)}% of the configured{" "}
          {formatBytes(env.storageLimitBytes)} limit). FireTrace never deletes data on its own; free
          space by deleting traces or projects, or raise the Firebase plan.
        </p>
      )}

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet."
          body={
            <>
              A project is a namespace for traces, with its own API keys. Create one such as{" "}
              <code className="font-mono text-ink">sandbox</code>, generate a key in its settings,
              then send a trace with the SDK or curl.
            </>
          }
        >
          <CreateProjectDialog primary />
          <Link href="/projects" className="hidden" aria-hidden />
        </EmptyState>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id} className="card flex flex-col p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/projects/${p.id}`}
                    className="block truncate text-lg font-semibold text-ink hover:underline"
                  >
                    {p.name}
                  </Link>
                  <p className="font-mono text-[11px] text-ink-3">
                    {p.slug}
                    {p.plan === "trial" && owner.role === "owner" && (
                      <span className="ml-2 rounded border border-warn/60 bg-warn/10 px-1.5 py-0.5 uppercase tracking-wider text-ink-2">
                        trial · {p.ownerEmail ?? p.ownerUid}
                      </span>
                    )}
                  </p>
                </div>
                <Link href={`/projects/${p.id}/settings`} className="btn btn-ghost btn-sm">
                  Settings
                </Link>
              </div>
              {p.description && (
                <p className="mt-2 line-clamp-2 text-sm text-ink-2">{p.description}</p>
              )}
              <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4">
                <div>
                  <dt className="mono-label">Traces</dt>
                  <dd className="mt-0.5 font-mono text-sm text-ink">
                    {p.traceCount.toLocaleString("en-US")}
                  </dd>
                </div>
                <div>
                  <dt className="mono-label">Est. storage</dt>
                  <dd
                    className="mt-0.5 font-mono text-sm text-ink"
                    title="FireTrace's serialized estimate, not Firebase's billable size"
                  >
                    {formatBytes(p.estimatedBytes)}
                  </dd>
                </div>
                <div>
                  <dt className="mono-label">Last trace</dt>
                  <dd className="mt-0.5 font-mono text-[11px] text-ink-2">
                    {p.lastTraceAt ? formatDateTime(p.lastTraceAt) : "never"}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
