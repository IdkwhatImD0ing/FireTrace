"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import {
  createEvaluatorAction,
  deleteEvaluatorAction,
  testEvaluatorAction,
  updateEvaluatorAction,
} from "@/lib/actions";
import type { PreviewOutcome } from "@/lib/eval/run";
import { EVAL_LIMITS, PROMPT_VARIABLES, type Evaluator } from "@/lib/eval/schema";
import type { EvaluatorTemplate } from "@/lib/eval/templates";
import { formatScoreValue, formatTokens } from "@/lib/format";

type Kind = Evaluator["outputType"]["kind"];

interface Draft {
  name: string;
  description: string;
  promptTemplate: string;
  kind: Kind;
  min: string;
  max: string;
  choices: string;
  model: string;
}

const EMPTY: Draft = {
  name: "",
  description: "",
  promptTemplate: "",
  kind: "numeric",
  min: "0",
  max: "1",
  choices: "",
  model: "",
};

function draftFrom(
  source: Pick<Evaluator, "name" | "description" | "promptTemplate" | "outputType"> & {
    model?: string | null;
  },
): Draft {
  const o = source.outputType;
  return {
    name: source.name,
    description: source.description,
    promptTemplate: source.promptTemplate,
    kind: o.kind,
    min: o.kind === "numeric" ? String(o.min) : "0",
    max: o.kind === "numeric" ? String(o.max) : "1",
    choices: o.kind === "categorical" ? o.choices.join(", ") : "",
    model: source.model ?? "",
  };
}

function inputFrom(d: Draft) {
  const outputType =
    d.kind === "numeric"
      ? { kind: "numeric" as const, min: Number(d.min), max: Number(d.max) }
      : d.kind === "categorical"
        ? {
            kind: "categorical" as const,
            choices: d.choices
              .split(",")
              .map((c) => c.trim())
              .filter(Boolean),
          }
        : { kind: "boolean" as const };
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    promptTemplate: d.promptTemplate,
    outputType,
    ...(d.model.trim() ? { model: d.model.trim() } : {}),
  };
}

function describeOutput(o: Evaluator["outputType"]): string {
  if (o.kind === "numeric") return `number ${o.min}–${o.max}`;
  if (o.kind === "categorical") return o.choices.join(" · ");
  return "true / false";
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p
      role="alert"
      className="rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit-2"
    >
      {error}
    </p>
  ) : null;
}

export function EvaluatorsPanel({
  projectId,
  evaluators,
  templates,
  configured,
  defaultModel,
}: {
  projectId: string;
  evaluators: Evaluator[];
  templates: readonly EvaluatorTemplate[];
  configured: boolean;
  defaultModel: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [testTraceId, setTestTraceId] = useState("");
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function open(id: string | null, draft: Draft) {
    setEditing({ id, draft });
    setTemplateId("");
    setPreview(null);
    setError(null);
  }

  function patch(changes: Partial<Draft>) {
    setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...changes } } : e));
  }

  function applyTemplate(id: string) {
    setTemplateId(id);
    const template = templates.find((t) => t.id === id);
    if (template) patch(draftFrom(template));
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setError(null);
    const input = inputFrom(editing.draft);
    startTransition(async () => {
      const result = editing.id
        ? await updateEvaluatorAction(projectId, editing.id, input)
        : await createEvaluatorAction(projectId, input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(null);
      router.refresh();
    });
  }

  function test() {
    if (!editing) return;
    setError(null);
    setPreview(null);
    const input = inputFrom(editing.draft);
    startTransition(async () => {
      const result = await testEvaluatorAction(projectId, input, testTraceId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.value);
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteEvaluatorAction(projectId, id);
      if (!result.ok) setError(result.error);
      setConfirmId(null);
      router.refresh();
    });
  }

  const d = editing?.draft;

  return (
    <section className="space-y-4" aria-labelledby="evaluators-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="evaluators-title" className="font-display text-2xl text-ink">
            Definitions
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            An evaluator is a prompt with <code className="font-mono text-ink">{"{{input}}"}</code>
            -style variables and the shape of the score it returns. Its name becomes the score name.
          </p>
        </div>
        {!editing && (
          <button type="button" className="btn btn-primary" onClick={() => open(null, EMPTY)}>
            New evaluator
          </button>
        )}
      </div>

      {!editing && <ErrorLine error={error} />}

      {evaluators.length === 0 && !editing && (
        <p className="card px-5 py-8 text-center text-sm text-ink-2">
          No evaluators yet. Start from a template or write your own prompt.
        </p>
      )}

      {evaluators.length > 0 && !editing && (
        <ul className="grid gap-3 md:grid-cols-2">
          {evaluators.map((ev) => (
            <li key={ev.id} className="card flex flex-col gap-2 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-ink" title={ev.name}>
                    {ev.name}
                  </p>
                  {ev.description && <p className="mt-0.5 text-sm text-ink-2">{ev.description}</p>}
                </div>
                <span className="chip shrink-0">{ev.outputType.kind}</span>
              </div>
              <p className="font-mono text-[11px] text-ink-3">
                {describeOutput(ev.outputType)} · model {ev.model ?? defaultModel ?? "unset"}
              </p>
              <div className="mt-auto flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => open(ev.id, draftFrom(ev))}
                  disabled={pending}
                >
                  Edit
                </button>
                {confirmId === ev.id ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => remove(ev.id)}
                      disabled={pending}
                    >
                      Confirm delete
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setConfirmId(null)}
                      disabled={pending}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirmId(ev.id)}
                    disabled={pending}
                    aria-label={`Delete evaluator ${ev.name}`}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && d && (
        <form onSubmit={save} className="card space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-xl text-ink">
              {editing.id ? "Edit evaluator" : "New evaluator"}
            </h3>
            {!editing.id && (
              <label className="flex items-center gap-2">
                <span className="mono-label">Start from</span>
                <select
                  className="input"
                  value={templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                >
                  <option value="">blank</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label>
              <span className="mono-label block">Name (score name)</span>
              <input
                className="input mt-1.5"
                value={d.name}
                onChange={(e) => patch({ name: e.target.value })}
                required
                pattern="[A-Za-z0-9_\-]{1,64}"
                title="Letters, digits, '_' and '-', at most 64 characters"
                placeholder="correctness"
              />
            </label>
            <label>
              <span className="mono-label block">Model (optional override)</span>
              <input
                className="input mt-1.5"
                value={d.model}
                onChange={(e) => patch({ model: e.target.value })}
                placeholder={defaultModel ?? "FIRETRACE_EVAL_MODEL"}
                maxLength={EVAL_LIMITS.maxModelLength}
              />
            </label>
            <label className="md:col-span-2">
              <span className="mono-label block">Description (optional)</span>
              <input
                className="input mt-1.5"
                value={d.description}
                onChange={(e) => patch({ description: e.target.value })}
                maxLength={EVAL_LIMITS.maxDescriptionLength}
                placeholder="When to use this evaluator"
              />
            </label>
            <label className="md:col-span-2">
              <span className="mono-label block">
                Prompt · variables: {PROMPT_VARIABLES.map((v) => `{{${v}}}`).join(" ")}
              </span>
              <textarea
                className="input mt-1.5 font-mono text-xs"
                rows={10}
                value={d.promptTemplate}
                onChange={(e) => patch({ promptTemplate: e.target.value })}
                required
                maxLength={EVAL_LIMITS.maxPromptChars}
                placeholder={
                  "Question:\n{{input}}\n\nAnswer:\n{{output}}\n\nIs the answer correct?"
                }
              />
            </label>
            <label>
              <span className="mono-label block">Score type</span>
              <select
                className="input mt-1.5"
                value={d.kind}
                onChange={(e) => patch({ kind: e.target.value as Kind })}
              >
                <option value="numeric">numeric</option>
                <option value="categorical">categorical</option>
                <option value="boolean">boolean</option>
              </select>
            </label>
            {d.kind === "numeric" && (
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className="mono-label block">Min</span>
                  <input
                    className="input mt-1.5"
                    type="number"
                    step="any"
                    value={d.min}
                    onChange={(e) => patch({ min: e.target.value })}
                    required
                  />
                </label>
                <label>
                  <span className="mono-label block">Max</span>
                  <input
                    className="input mt-1.5"
                    type="number"
                    step="any"
                    value={d.max}
                    onChange={(e) => patch({ max: e.target.value })}
                    required
                  />
                </label>
              </div>
            )}
            {d.kind === "categorical" && (
              <label>
                <span className="mono-label block">Choices (comma-separated, 2–20)</span>
                <input
                  className="input mt-1.5"
                  value={d.choices}
                  onChange={(e) => patch({ choices: e.target.value })}
                  required
                  placeholder="billing, sales, other"
                />
              </label>
            )}
          </div>

          <div className="rounded-md border border-line bg-bg-2 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-72 flex-1">
                <span className="mono-label block">Test on a trace id (writes nothing)</span>
                <input
                  className="input mt-1.5 font-mono text-xs"
                  value={testTraceId}
                  onChange={(e) => setTestTraceId(e.target.value)}
                  placeholder="32 hex characters from the trace list"
                />
              </label>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={test}
                disabled={pending || !configured || !testTraceId.trim()}
                title={configured ? undefined : "Configure FIRETRACE_EVAL_* first"}
              >
                {pending ? "Asking the judge…" : "Test"}
              </button>
            </div>
            {preview && (
              <div className="mt-3 space-y-2 text-sm">
                {preview.parsed.ok ? (
                  <p className="text-ink">
                    Verdict:{" "}
                    <span className="font-mono text-ember-2">
                      {formatScoreValue(preview.parsed.value)}
                    </span>
                    {preview.parsed.reasoning && (
                      <span className="text-ink-2"> · {preview.parsed.reasoning}</span>
                    )}
                  </p>
                ) : (
                  <p className="text-crit-2">{preview.parsed.error}</p>
                )}
                <p className="font-mono text-[11px] text-ink-3">
                  {preview.model ?? "model unknown"} ·{" "}
                  {preview.usage?.totalTokens !== undefined
                    ? `${formatTokens(preview.usage.totalTokens)} tokens`
                    : "usage unknown"}{" "}
                  · {preview.durationMs} ms
                </p>
                <details>
                  <summary className="cursor-pointer text-ink-2">Rendered prompt</summary>
                  <pre className="pre mt-2 max-h-72 overflow-auto">{preview.rendered}</pre>
                </details>
                <details>
                  <summary className="cursor-pointer text-ink-2">Raw answer</summary>
                  <pre className="pre mt-2 max-h-48 overflow-auto">{preview.raw}</pre>
                </details>
              </div>
            )}
          </div>

          <ErrorLine error={error} />

          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary" disabled={pending}>
              {pending ? "Saving…" : editing.id ? "Save changes" : "Create evaluator"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setEditing(null)}
              disabled={pending}
            >
              Cancel
            </button>
            <Link href={`/projects/${projectId}`} className="btn btn-ghost ml-auto">
              Trace list
            </Link>
          </div>
        </form>
      )}
    </section>
  );
}
