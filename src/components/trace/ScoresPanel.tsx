"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { addScoreAction, deleteScoreAction } from "@/lib/actions";
import { SCORE_DATA_TYPES, SCORE_LIMITS, type ScoreDataType } from "@/lib/firetrace/schema";
import type { Score, ScoreValue } from "@/lib/firetrace/types";
import { formatDateTime, formatScoreValue } from "@/lib/format";

const PLACEHOLDER: Record<ScoreDataType, string> = {
  numeric: "0.8",
  categorical: "billing",
  boolean: "",
};

/** Scores tab of the trace inspector: the trace's score history plus an annotation form. */
export function ScoresPanel({
  projectId,
  traceId,
  scores,
}: {
  projectId: string;
  traceId: string;
  scores: Score[];
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [dataType, setDataType] = useState<ScoreDataType>("numeric");
  const [value, setValue] = useState("");
  const [comment, setComment] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function parsedValue(): ScoreValue | null {
    if (dataType === "numeric") {
      const n = Number(value);
      return value.trim() && Number.isFinite(n) ? n : null;
    }
    if (dataType === "boolean") return value === "true" ? true : value === "false" ? false : null;
    return value.trim() ? value.trim() : null;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = parsedValue();
    if (parsed === null) {
      setError(
        dataType === "numeric"
          ? "Enter a number."
          : dataType === "boolean"
            ? "Pick true or false."
            : "Enter a label.",
      );
      return;
    }
    startTransition(async () => {
      const result = await addScoreAction(projectId, traceId, {
        name: name.trim(),
        dataType,
        value: parsed,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setValue("");
      setComment("");
      router.refresh();
    });
  }

  function remove(scoreId: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteScoreAction(projectId, traceId, scoreId);
      if (!result.ok) setError(result.error);
      setConfirmId(null);
      router.refresh();
    });
  }

  return (
    <div>
      {scores.length === 0 ? (
        <p className="text-sm text-ink-3">No scores yet.</p>
      ) : (
        <ul className="space-y-2">
          {scores.map((s) => (
            <li key={s.id} className="rounded-md border border-line bg-bg-2 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-ink">{s.name}</span>
                    <span className="font-mono text-sm text-ember-2">
                      = {formatScoreValue(s.value)}
                    </span>
                    <span className="chip">{s.source}</span>
                    {s.spanId && (
                      <span className="chip" title="Scoped to one span">
                        span {s.spanId}
                      </span>
                    )}
                  </div>
                  {s.comment && (
                    <p className="mt-1 text-sm break-words whitespace-pre-wrap text-ink-2">
                      {s.comment}
                    </p>
                  )}
                  <p className="mt-1 font-mono text-[10px] text-ink-3">
                    {formatDateTime(s.createdAt)}
                    {s.evaluatorId ? ` · evaluator ${s.evaluatorId}` : ""}
                  </p>
                </div>
                {confirmId === s.id ? (
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => remove(s.id)}
                      disabled={pending}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmId(null)}
                      disabled={pending}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm shrink-0"
                    onClick={() => setConfirmId(s.id)}
                    disabled={pending}
                    aria-label={`Delete score ${s.name}`}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="mt-4 border-t border-line pt-4">
        <p className="mono-label">Add score</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <label>
            <span className="mono-label block">Name</span>
            <input
              className="input mt-1.5"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              pattern="[A-Za-z0-9_\-]{1,64}"
              title="Letters, digits, '_' and '-', at most 64 characters"
              placeholder="helpful"
              maxLength={SCORE_LIMITS.maxNameLength}
            />
          </label>
          <label>
            <span className="mono-label block">Type</span>
            <select
              className="input mt-1.5"
              value={dataType}
              onChange={(e) => {
                setDataType(e.target.value as ScoreDataType);
                setValue("");
              }}
            >
              {SCORE_DATA_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2">
            <span className="mono-label block">Value</span>
            {dataType === "boolean" ? (
              <select
                className="input mt-1.5"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
              >
                <option value="">pick…</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                className="input mt-1.5"
                type={dataType === "numeric" ? "number" : "text"}
                step="any"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
                placeholder={PLACEHOLDER[dataType]}
                maxLength={SCORE_LIMITS.maxValueLength}
              />
            )}
          </label>
          <label className="col-span-2">
            <span className="mono-label block">Comment (optional)</span>
            <textarea
              className="input mt-1.5"
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={SCORE_LIMITS.maxCommentLength}
              placeholder="Why this score was given"
            />
          </label>
        </div>
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit-2"
          >
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary btn-sm mt-3" disabled={pending}>
          {pending ? "Saving…" : "Add score"}
        </button>
      </form>
    </div>
  );
}
