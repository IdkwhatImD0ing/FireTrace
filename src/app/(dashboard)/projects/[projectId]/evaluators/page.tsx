import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvalRunsTable } from "@/components/evaluators/EvalRunsTable";
import { EvaluatorsPanel } from "@/components/evaluators/EvaluatorsPanel";
import { serverEnv } from "@/lib/env/server";
import { listEvalRuns, listEvaluators } from "@/lib/eval/evaluators";
import { BUILT_IN_TEMPLATES } from "@/lib/eval/templates";
import { adminDb } from "@/lib/firebase/admin";
import { isProjectId } from "@/lib/firetrace/ids";
import { getAccessibleProject } from "@/lib/auth/access";
import { requireOwnerOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Evaluators" };
/** Test runs call the judge from a server action; give them room. */
export const maxDuration = 300;

export default async function EvaluatorsPage({
  params,
}: PageProps<"/projects/[projectId]/evaluators">) {
  const owner = await requireOwnerOrRedirect();
  const { projectId } = await params;
  if (!isProjectId(projectId)) notFound();
  const env = serverEnv();
  const db = adminDb();
  const project = await getAccessibleProject(db, owner, projectId);
  if (!project) notFound();
  const isOwner = owner.role === "owner";
  const [evaluators, runs] = isOwner
    ? await Promise.all([listEvaluators(db, projectId), listEvalRuns(db, projectId, { limit: 50 })])
    : [[], []];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${projectId}`}
          className="mono-label inline-flex items-center gap-1.5 hover:text-ink-2"
        >
          <span aria-hidden>←</span> {project.name}
        </Link>
        <h1 className="mt-1 font-display text-5xl leading-none text-ink">Evaluators</h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">
          LLM-as-a-judge scoring: a prompt built from a trace, answered by a model, stored as a
          score. Run one from a trace page or over the filtered trace list.{" "}
          <Link href="/docs/evaluators" className="text-ink underline">
            How it works
          </Link>
          .
        </p>
      </div>

      {!isOwner ? (
        <p className="card px-5 py-8 text-center text-sm text-ink-2">
          Evaluators run on the deployment owner&apos;s model key, so only owners can define and run
          them.
        </p>
      ) : (
        <>
          {!env.eval && (
            <div role="status" className="card border-warn/50 p-4 text-sm text-ink-2">
              <p className="mono-label text-warn">Judge endpoint not configured</p>
              <p className="mt-1">
                Set <code className="font-mono text-ink">FIRETRACE_EVAL_BASE_URL</code>,{" "}
                <code className="font-mono text-ink">FIRETRACE_EVAL_API_KEY</code> and{" "}
                <code className="font-mono text-ink">FIRETRACE_EVAL_MODEL</code> on the server to
                run evaluators. Any OpenAI-compatible chat-completions endpoint works. Definitions
                can be created meanwhile.
              </p>
            </div>
          )}
          <EvaluatorsPanel
            projectId={projectId}
            evaluators={evaluators}
            templates={BUILT_IN_TEMPLATES}
            configured={env.eval !== null}
            defaultModel={env.eval?.model ?? null}
          />
          <EvalRunsTable projectId={projectId} runs={runs} />
        </>
      )}
    </div>
  );
}
