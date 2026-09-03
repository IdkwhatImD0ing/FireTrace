"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { deleteProjectAction } from "@/lib/actions";

export function DeleteProjectDialog({
  projectId,
  projectName,
  traceCount,
}: {
  projectId: string;
  projectName: string;
  traceCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteProjectAction(projectId, typed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/projects");
      router.refresh();
    });
  }

  return (
    <section className="card border-crit/40 p-5" aria-labelledby="danger-title">
      <h2 id="danger-title" className="font-display text-2xl text-ink">
        Delete project
      </h2>
      <p className="mt-1 text-sm text-ink-2">
        Removes this project, its {traceCount.toLocaleString("en-US")} traces with all spans, and
        every API key. Nothing else in your Firebase project is touched. This is permanent.
      </p>
      <div className="mt-4">
        <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
          Delete project…
        </button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        dismissible={!pending}
        title="Delete this project?"
        labelledBy="delete-project-title"
      >
        <p className="text-sm text-ink-2">
          Type <span className="font-mono text-ink">{projectName}</span> to confirm. Deletion walks
          every trace and span and may take a while for large projects; keep this page open until it
          finishes.
        </p>
        <input
          className="input mt-3"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={projectName}
          aria-label="Project name confirmation"
          autoFocus
        />
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit-2"
          >
            {error}
          </p>
        )}
        {pending && (
          <p role="status" className="mt-3 text-sm text-ink-2">
            Deleting traces, spans and keys…
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={confirm}
            disabled={pending || typed.trim() !== projectName}
          >
            {pending ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
