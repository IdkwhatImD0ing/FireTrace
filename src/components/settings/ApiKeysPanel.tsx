"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog } from "@/components/ui/Dialog";
import { createApiKeyAction, revokeApiKeyAction, rotateApiKeyAction } from "@/lib/actions";
import { redactedKeyReference } from "@/lib/firetrace/api-key-format";
import {
  DEFAULT_KEY_SCOPES,
  KEY_SCOPES,
  SCOPE_DESCRIPTIONS,
  type KeyScope,
} from "@/lib/firetrace/scopes";
import type { ApiKeySummary } from "@/lib/firetrace/types";
import { formatDateTime } from "@/lib/format";

type Reveal = { label: string; plaintext: string; reason: "created" | "rotated" };

const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
];

const SCOPE_SHORT: Record<KeyScope, string> = {
  "traces:write": "write",
  "traces:read": "read",
  "traces:delete": "delete",
};

function expiryLabel(key: ApiKeySummary, now: number): { text: string; tone: string } {
  if (!key.expiresAt) return { text: "never", tone: "text-ink-3" };
  const expired = Date.parse(key.expiresAt) <= now;
  return {
    text: formatDateTime(key.expiresAt),
    tone: expired ? "text-crit-2" : "text-ink-2",
  };
}

export function ApiKeysPanel({ projectId, keys }: { projectId: string; keys: ApiKeySummary[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<KeyScope[]>(DEFAULT_KEY_SCOPES);
  const [expiry, setExpiry] = useState("never");
  const [confirm, setConfirm] = useState<{
    action: "revoke" | "rotate";
    key: ApiKeySummary;
  } | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Captured once per mount so render stays pure; the page re-renders on refresh.
  const [now] = useState(() => Date.now());

  function toggleScope(scope: KeyScope) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  function resetForm() {
    setLabel("");
    setScopes(DEFAULT_KEY_SCOPES);
    setExpiry("never");
  }

  function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createApiKeyAction(projectId, { label, scopes, expiry });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCreateOpen(false);
      resetForm();
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
            Keys authenticate the REST API and the MCP endpoint for this project only. Each key
            carries the scopes you pick here; only a hash is stored and the plaintext is shown once.
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
        <table className="table-dense w-full min-w-[820px] border-collapse">
          <thead>
            <tr>
              <th scope="col">Label</th>
              <th scope="col">Key</th>
              <th scope="col">Scopes</th>
              <th scope="col">Created (UTC)</th>
              <th scope="col">Expires (UTC)</th>
              <th scope="col">Last used</th>
              <th scope="col">Status</th>
              <th scope="col" className="text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-ink-3">
                  No keys yet. Create one to start sending traces.
                </td>
              </tr>
            )}
            {[...active, ...revoked].map((k) => {
              const exp = expiryLabel(k, now);
              return (
                <tr key={k.id} className={k.revokedAt ? "opacity-60" : ""}>
                  <td className="text-ink">{k.label}</td>
                  <td className="font-mono text-xs text-ink-2">
                    {redactedKeyReference(k.id, k.lastFour)}
                  </td>
                  <td>
                    <span className="inline-flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <span
                          key={s}
                          title={SCOPE_DESCRIPTIONS[s]}
                          className="rounded border border-line-2 bg-bg-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-2"
                        >
                          {SCOPE_SHORT[s]}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="font-mono text-[11px] text-ink-2">
                    {formatDateTime(k.createdAt)}
                  </td>
                  <td className={`font-mono text-[11px] ${exp.tone}`}>{exp.text}</td>
                  <td className="font-mono text-[11px] text-ink-2">
                    {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "—"}
                  </td>
                  <td className="font-mono text-[11px] uppercase tracking-wider">
                    {k.revokedAt ? (
                      <span className="text-ink-3" title={`Revoked ${formatDateTime(k.revokedAt)}`}>
                        revoked
                      </span>
                    ) : k.expiresAt && Date.parse(k.expiresAt) <= now ? (
                      <span className="text-crit-2">expired</span>
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
              );
            })}
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

          <fieldset>
            <legend className="mono-label">Scopes</legend>
            <p className="mt-1 text-xs text-ink-3">
              Give each key the least it needs. An SDK in your app usually only needs write.
            </p>
            <div className="mt-2 space-y-2">
              {KEY_SCOPES.map((scope) => (
                <label key={scope} className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-ember"
                    checked={scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                    name="scope"
                    value={scope}
                  />
                  <span>
                    <code className="font-mono text-xs text-ink">{scope}</code>
                    <span className="block text-xs text-ink-2">{SCOPE_DESCRIPTIONS[scope]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="mono-label block">Expires</span>
            <select
              className="input mt-1.5"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              name="expiry"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <p className="-mt-2 text-xs text-ink-3">
            Expired keys are rejected with 401; rotate before the date to keep the same name.
          </p>

          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={pending || label.trim() === "" || scopes.length === 0}
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
            ? `A new key labeled "${confirm.key.label}" with the same scopes and expiry will be issued and the current one revoked immediately. Update your application with the new key.`
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
