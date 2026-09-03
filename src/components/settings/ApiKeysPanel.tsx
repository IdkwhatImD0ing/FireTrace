"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog } from "@/components/ui/Dialog";
import { createApiKeyAction, revokeApiKeyAction, rotateApiKeyAction } from "@/lib/actions";
import { redactedKeyReference } from "@/lib/firetrace/api-key-format";
import type { ApiKeySummary } from "@/lib/firetrace/types";
import { formatDateTime } from "@/lib/format";

type Reveal = { label: string; plaintext: string; reason: "created" | "rotated" };

export function ApiKeysPanel({ projectId, keys }: { projectId: string; keys: ApiKeySummary[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [confirm, setConfirm] = useState<{
    action: "revoke" | "rotate";
    key: ApiKeySummary;
  } | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createApiKeyAction(projectId, label);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCreateOpen(false);
      setLabel("");
      setReveal({
        label: result.value.key.label,
        plaintext: result.value.plaintext,
        reason: "created",
      });
      router.refresh();
    });
  }

  function runConfirm() {
    if (!confirm) return;
    const { action, key } = confirm;
    setError(null);
    startTransition(async () => {
      if (action === "revoke") {
        const result = await revokeApiKeyAction(projectId, key.id);
        if (!result.ok) setError(result.error);
      } else {
        const result = await rotateApiKeyAction(projectId, key.id);
        if (!result.ok) setError(result.error);
        else
          setReveal({
            label: result.value.key.label,
            plaintext: result.value.plaintext,
            reason: "rotated",
          });
      }
      setConfirm(null);
      router.refresh();
    });
  }

  const active = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt);

  return (
    <section className="card p-5" aria-labelledby="keys-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="keys-title" className="font-display text-2xl text-ink">
            API keys
          </h2>
          <p className="mt-1 text-sm text-ink-2">
            Keys authenticate <code className="font-mono text-ink">POST /api/v1/traces</code> for
            this project only. Only a hash is stored; plaintext is shown once.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          Create key
        </button>
      </div>

      {reveal && (
        <div role="status" className="mt-4 rounded-md border border-ember/60 bg-ember-dim p-4">
          <p className="mono-label text-ember-2">
            {reveal.reason === "rotated" ? "Rotated" : "Created"} · copy it now, it will not be
            shown again
          </p>
          <p className="mt-1 text-sm text-ink-2">
            Key <span className="text-ink">{reveal.label}</span>. Store it in your
            application&apos;s secret manager.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 rounded-md border border-line-2 bg-bg-2 px-3 py-2 font-mono text-xs break-all text-ink select-all">
              {reveal.plaintext}
            </code>
            <CopyButton text={reveal.plaintext} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReveal(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit-2"
        >
          {error}
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="table-dense w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col">Key</th>
              <th scope="col">Created (UTC)</th>
              <th scope="col">Status</th>
              <th scope="col" className="text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-ink-3">
                  No keys yet. Create one to start sending traces.
                </td>
              </tr>
            )}
            {[...active, ...revoked].map((k) => (
              <tr key={k.id} className={k.revokedAt ? "opacity-60" : ""}>
                <td className="text-ink">{k.label}</td>
                <td className="font-mono text-xs text-ink-2">
                  {redactedKeyReference(k.id, k.lastFour)}
                </td>
                <td className="font-mono text-[11px] text-ink-2">{formatDateTime(k.createdAt)}</td>
                <td className="font-mono text-[11px] uppercase tracking-wider">
                  {k.revokedAt ? (
                    <span className="text-ink-3" title={`Revoked ${formatDateTime(k.revokedAt)}`}>
                      revoked
                    </span>
                  ) : (
                    <span className="text-good">active</span>
                  )}
                </td>
                <td className="text-right">
                  {!k.revokedAt && (
                    <span className="inline-flex gap-2">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setConfirm({ action: "rotate", key: k })}
                      >
                        Rotate
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => setConfirm({ action: "revoke", key: k })}
                      >
                        Revoke
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create an API key"
        labelledBy="create-key-title"
      >
        <form onSubmit={create} className="space-y-4">
          <label className="block">
            <span className="mono-label block">Label</span>
            <input
              className="input mt-1.5"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="production"
              maxLength={80}
              required
              autoFocus
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pending || label.trim() === ""}
            >
              {pending ? "Creating…" : "Create key"}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.action === "rotate" ? "Rotate this key?" : "Revoke this key?"}
        labelledBy="confirm-key-title"
      >
        <p className="text-sm text-ink-2">
          {confirm?.action === "rotate"
            ? `A new key labeled "${confirm.key.label}" will be issued and the current one revoked immediately. Update your application with the new key.`
            : `Requests using "${confirm?.key.label}" will fail immediately. This cannot be undone.`}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setConfirm(null)}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${confirm?.action === "rotate" ? "btn-primary" : "btn-danger"}`}
            onClick={runConfirm}
            disabled={pending}
          >
            {pending ? "Working…" : confirm?.action === "rotate" ? "Rotate key" : "Revoke key"}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
