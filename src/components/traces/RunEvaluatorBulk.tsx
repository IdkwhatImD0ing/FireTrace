"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runEvaluatorBulkAction } from "@/lib/actions";
import type { BulkOutcome } from "@/lib/eval/run";

/** Run one evaluator over the traces matching the list's current filters (owners only). */
export function RunEvaluatorBulk({
  projectId,
  evaluators,
  filters,
  traceCount,
  maxTraces,
  configured,
}: {
  projectId: string;
  evaluators: Array<{ id: string; name: string }>;
  filters: Record<string, string | undefined>;
  traceCount: number;
  maxTraces: number;
  configured: boolean;
}) {
  const router = useRouter();
  const [evaluatorId, setEvaluatorId] = useState(evaluators[0]?.id ?? "");
  const [force, setForce] = useState(false);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const target = Math.min(traceCount, maxTraces);

  function runNow() {
    setError(null);
    setOutcome(null);
    startTransition(async () => {
      const result = await runEvaluatorBulkAction(projectId, evaluatorId, filters, force);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome(result.value);
      router.refresh();
    });
  }

  return (
    <div className="card flex flex-wrap items-end gap-3 p-4">
      <label className="min-w-40">
        <span className="mono-label block">Evaluator</span>
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
        re-run scored traces
      </label>
      <button
        type="button"
        className="btn btn-primary"
        onClick={runNow}
        disabled={pending || !configured || target === 0}
        title={configured ? undefined : "Configure FIRETRACE_EVAL_* to run evaluators"}
      >
        {pending ? "Judging…" : `Run on these ${target} trace${target === 1 ? "" : "s"}`}
      </button>
      <span className="pb-2 font-mono text-[11px] text-ink-3">
        newest first, at most {maxTraces} per run
      </span>
      {outcome && (
        <p className="w-full text-sm text-ink-2" role="status">
          Done: {outcome.ok} scored, {outcome.skipped} already scored
          {outcome.failed > 0 ? (
            <span className="text-crit-2">, {outcome.failed} failed (see the run log)</span>
          ) : (
            ""
          )}
          .
        </p>
      )}
      {error && (
        <p role="alert" className="w-full text-sm text-crit-2">
          {error}
        </p>
      )}
    </div>
  );
}
