"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runEvaluatorAction } from "@/lib/actions";
import type { RunOutcome } from "@/lib/eval/run";
import { formatScoreValue } from "@/lib/format";

/** Run one evaluator against this trace from the Scores tab (owners only). */
export function RunEvaluatorButton({
  projectId,
  traceId,
  evaluators,
  configured,
}: {
  projectId: string;
  traceId: string;
  evaluators: Array<{ id: string; name: string }>;
  configured: boolean;
}) {
  const router = useRouter();
  const [evaluatorId, setEvaluatorId] = useState(evaluators[0]?.id ?? "");
  const [force, setForce] = useState(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (evaluators.length === 0) {
    return (
      <p className="mb-4 text-sm text-ink-3">
        No evaluators yet.{" "}
        <Link href={`/projects/${projectId}/evaluators`} className="text-ink underline">
          Create one
        </Link>{" "}
        to score traces with an LLM judge.
      </p>
    );
  }

  function runNow() {
    setError(null);
    setOutcome(null);
    startTransition(async () => {
      const result = await runEvaluatorAction(projectId, evaluatorId, traceId, force);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome(result.value);
      router.refresh();
    });
  }

  return (
    <div className="mb-4 rounded-md border border-line bg-bg-2 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1">
          <span className="mono-label block">Run evaluator</span>
          <select
            className="input mt-1.5"
            value={evaluatorId}
            onChange={(e) => setEvaluatorId(e.target.value)}
          >
            {evaluators.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-ink-2">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          re-run if scored
        </label>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={runNow}
          disabled={pending || !configured}
          title={configured ? undefined : "Configure FIRETRACE_EVAL_* to run evaluators"}
        >
          {pending ? "Judging…" : "Run"}
        </button>
      </div>
      {!configured && (
        <p className="mt-2 text-xs text-ink-3">
          Set FIRETRACE_EVAL_BASE_URL, FIRETRACE_EVAL_API_KEY and FIRETRACE_EVAL_MODEL to run
          evaluators.
        </p>
      )}
      {outcome && (
        <p className="mt-2 text-sm text-ink-2" role="status">
          {outcome.status === "ok" && (
            <>
              Scored{" "}
              <span className="font-mono text-ember-2">
                {outcome.score.name}={formatScoreValue(outcome.score.value)}
              </span>
              {outcome.score.comment ? ` · ${outcome.score.comment}` : ""}
            </>
          )}
          {outcome.status === "skipped" && `Skipped: ${outcome.reason}. Tick re-run to force.`}
          {outcome.status === "failed" && (
            <span className="text-crit-2">Run failed: {outcome.error}</span>
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-crit-2">
          {error}
        </p>
      )}
    </div>
  );
}
