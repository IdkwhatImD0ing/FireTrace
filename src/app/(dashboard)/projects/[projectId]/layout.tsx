import Link from "next/link";
import { notFound } from "next/navigation";
import { EnvironmentSelector } from "@/components/dashboard/EnvironmentSelector";
import { ProjectSidebar } from "@/components/dashboard/ProjectSidebar";
import { getEnvironmentView } from "@/lib/environment-selection";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectId } from "@/lib/firetrace/ids";
import { getAccessibleProject } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";

/**
 * Every page inside a project shares the environment bar and the sidebar;
 * pages re-check access themselves. The bar is sticky so the active
 * environment is never out of sight while reading numbers.
 */
export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId } = await params;
  if (!isProjectId(projectId)) notFound();
  const db = adminDb();
  const project = await getAccessibleProject(db, owner, projectId);
  if (!project) notFound();
  const view = await getEnvironmentView(db, projectId);

  return (
    <div>
      <div className="sticky top-14 z-20 -mx-4 -mt-8 mb-6 border-b border-line bg-bg px-4 sm:-mx-6 sm:px-6">
        <div className="flex h-11 items-center gap-3 overflow-x-auto">
          <EnvironmentSelector selection={view.selection} options={view.options} />
          <span className="hidden whitespace-nowrap font-mono text-[11px] text-ink-3 md:inline">
            every list and number below follows this choice
          </span>
          <Link
            href={`/projects/${projectId}/settings`}
            className="ml-auto whitespace-nowrap font-mono text-[11px] text-ink-2 hover:text-ink"
          >
            {view.options.length === 0 ? "assign environments to keys →" : "keys →"}
          </Link>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
        <ProjectSidebar
          projectId={projectId}
          projectName={project.name}
          showEvaluators={owner.role === "owner"}
        />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
