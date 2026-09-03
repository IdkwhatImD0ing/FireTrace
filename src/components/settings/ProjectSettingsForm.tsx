"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { updateProjectAction } from "@/lib/actions";

export function ProjectSettingsForm({
  projectId,
  initialName,
  initialDescription,
}: {
  projectId: string;
  initialName: string;
  initialDescription: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await updateProjectAction(projectId, { name, description });
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        return;
      }
      setMessage({ kind: "ok", text: "Saved." });
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-5">
      <h2 className="font-display text-2xl text-ink">General</h2>
      <label className="block">
        <span className="mono-label block">Name</span>
        <input
          className="input mt-1.5"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          required
        />
      </label>
      <label className="block">
        <span className="mono-label block">Description</span>
        <input
          className="input mt-1.5"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
        />
      </label>
      <div className="rounded-md border border-line bg-bg-2 p-3 text-sm text-ink-2">
        <span className="mono-label block">Content capture</span>
        <p className="mt-1">
          <span className="text-ink">On.</span> Inputs and outputs sent by your application are
          stored as-is. Redact secrets and regulated personal data before sending (the SDK exposes a
          redaction hook).
        </p>
      </div>
      {message && (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={`rounded-md border px-3 py-2 text-sm ${
            message.kind === "error"
              ? "border-crit/40 bg-crit/10 text-crit-2"
              : "border-good/40 bg-good/10 text-ink"
          }`}
        >
          {message.text}
        </p>
      )}
      <div className="flex justify-end">
        <button type="submit" className="btn btn-primary" disabled={pending || name.trim() === ""}>
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
