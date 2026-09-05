import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiKeysPanel } from "@/components/settings/ApiKeysPanel";
import { DeleteProjectDialog } from "@/components/settings/DeleteProjectDialog";
import { ProjectSettingsForm } from "@/components/settings/ProjectSettingsForm";
import { serverEnv } from "@/lib/env/server";
import { listProjectApiKeys } from "@/lib/environment-selection";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectId } from "@/lib/firetrace/ids";
import { formatBytes, percentOfLimit, storageLevel } from "@/lib/firetrace/storage";
import { getAccessibleProject } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Project settings" };

export default async function ProjectSettingsPage({
  params,
}: PageProps<"/projects/[projectId]/settings">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId } = await params;
  if (!isProjectId(projectId)) notFound();
  const env = serverEnv();
  const db = adminDb();
  const project = await getAccessibleProject(db, owner, projectId);
  if (!project) notFound();
  const keys = await listProjectApiKeys(db, projectId);
  const level = storageLevel(project.estimatedBytes, env.storageLimitBytes);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="mono-label inline-flex items-center gap-1.5 hover:text-ink-2"
        >
          <span aria-hidden>←</span> {project.name}
        </Link>
        <h1 className="mt-1 font-display text-5xl leading-none text-ink">Settings</h1>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ProjectSettingsForm
          projectId={projectId}
          initialName={project.name}
          initialDescription={project.description}
        />

        <section className="card p-5" aria-labelledby="usage-title">
          <h2 id="usage-title" className="font-display text-2xl text-ink">
            Estimated usage
          </h2>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <div>
              <dt className="mono-label">Traces</dt>
              <dd className="mt-0.5 font-mono text-lg text-ink">
                {project.traceCount.toLocaleString("en-US")}
              </dd>
            </div>
            <div>
              <dt className="mono-label">Spans</dt>
              <dd className="mt-0.5 font-mono text-lg text-ink">
                {project.spanCount.toLocaleString("en-US")}
              </dd>
            </div>
            <div>
              <dt className="mono-label">Est. bytes</dt>
              <dd className="mt-0.5 font-mono text-lg text-ink">
                {formatBytes(project.estimatedBytes)}
              </dd>
            </div>
          </dl>
          <div className="mt-4">
            <div className="flex items-center justify-between font-mono text-[11px] text-ink-3">
              <span>
                {percentOfLimit(project.estimatedBytes, env.storageLimitBytes)}% of{" "}
                {formatBytes(env.storageLimitBytes)}
              </span>
              <span>
                {level === "ok"
                  ? "within allowance"
                  : level === "warning"
                    ? "approaching limit"
                    : "near limit"}
              </span>
            </div>
            <div
              className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3"
              role="presentation"
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${percentOfLimit(project.estimatedBytes, env.storageLimitBytes)}%`,
                  background:
                    level === "ok"
                      ? "var(--color-ember)"
                      : level === "warning"
                        ? "var(--color-warn)"
                        : "var(--color-crit)",
                }}
              />
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-ink-2">
            These figures cover every environment: storage is one quota for the whole project.
            Infinite retention means FireTrace never deletes data because of its age. Capacity is
            bounded by your Firebase plan&apos;s storage quota: on the Firestore free tier that is 1
            GiB of stored data. The figure above is FireTrace&apos;s serialized estimate, not
            Firebase&apos;s billable measurement; check the{" "}
            <a
              href="https://firebase.google.com/docs/firestore/pricing"
              className="underline"
              target="_blank"
              rel="noreferrer"
            >
              Firestore pricing page
            </a>{" "}
            for current quotas.
          </p>
        </section>
      </div>

      <ApiKeysPanel projectId={projectId} keys={keys} />

      <DeleteProjectDialog
        projectId={projectId}
        projectName={project.name}
        traceCount={project.traceCount}
      />
    </div>
  );
}
