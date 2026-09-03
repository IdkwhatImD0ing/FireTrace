"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { createProjectAction } from "@/lib/actions";

export function CreateProjectDialog({ primary = false }: { primary?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createProjectAction({ name, description });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setName("");
      setDescription("");
      router.push(`/projects/${result.value.projectId}`);
    });
  }

  return (
    <>
      <button
        type="button"
        className={`btn ${primary ? "btn-primary" : "btn-ghost"}`}
        onClick={() => setOpen(true)}
      >
        New project
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Create a project"
        labelledBy="create-project-title"
      >
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mono-label block">Name</span>
            <input
              className="input mt-1.5"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="personal-assistant"
              maxLength={80}
              required
              autoFocus
            />
            <span className="mt-1 block text-xs text-ink-3">
              A namespace for traces. Names are unique per deployment.
            </span>
          </label>
          <label className="block">
            <span className="mono-label block">Description (optional)</span>
            <input
              className="input mt-1.5"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this project traces"
              maxLength={500}
            />
          </label>
          {error && (
            <p
              role="alert"
              className="rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit-2"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pending || name.trim() === ""}
            >
              {pending ? "Creating…" : "Create project"}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
