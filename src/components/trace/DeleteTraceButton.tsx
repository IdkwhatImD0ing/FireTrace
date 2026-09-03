"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { deleteTraceAction } from "@/lib/actions";

export function DeleteTraceButton({
  projectId,
  traceId,
  traceName,
}: {
  projectId: string;
  traceId: string;
  traceName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteTraceAction(projectId, traceId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/projects/${projectId}`);
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => setOpen(true)}>
        Delete trace
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Delete this trace?"
        labelledBy="delete-trace-title"
      >
        <p className="text-sm text-ink-2">
          <span className="text-ink">{traceName}</span> and all of its spans will be removed
          permanently. FireTrace never deletes traces on its own; this is the only way data leaves
          your Firestore database.
        </p>
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit-2"
          >
            {error}
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
          <button type="button" className="btn btn-danger" onClick={confirm} disabled={pending}>
            {pending ? "Deleting…" : "Delete trace"}
          </button>
        </div>
      </Dialog>
    </>
  );
}
