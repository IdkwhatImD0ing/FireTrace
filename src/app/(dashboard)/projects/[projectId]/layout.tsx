import { notFound } from "next/navigation";
import { ProjectSidebar } from "@/components/dashboard/ProjectSidebar";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectId } from "@/lib/firetrace/ids";
import { getAccessibleProject } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";

/** Every page inside a project shares the sidebar; pages re-check access themselves. */
export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId } = await params;
  if (!isProjectId(projectId)) notFound();
  const project = await getAccessibleProject(adminDb(), owner, projectId);
  if (!project) notFound();

  return (
    <div className="grid gap-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
      <ProjectSidebar
        projectId={projectId}
        projectName={project.name}
        showEvaluators={owner.role === "owner"}
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
