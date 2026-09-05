import { notFound } from "next/navigation";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectId, isTraceId } from "@/lib/firetrace/ids";
import { getAccessibleTrace } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";

/**
 * Existence check above the page's loading boundary: a missing or foreign
 * trace becomes a real HTTP 404 here, before anything streams. The page reads
 * the same memoized trace, so this costs no extra document read.
 */
export default async function TraceLayout({
  children,
  params,
}: LayoutProps<"/projects/[projectId]/traces/[traceId]">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId, traceId } = await params;
  if (!isProjectId(projectId) || !isTraceId(traceId)) notFound();
  const trace = await getAccessibleTrace(adminDb(), owner, projectId, traceId);
  if (!trace) notFound();
  return children;
}
