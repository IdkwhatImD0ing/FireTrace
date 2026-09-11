import type { StoredTraceStatus } from "@/lib/firetrace/schema";

const STYLE: Record<StoredTraceStatus, { color: string; label: string }> = {
  ok: { color: "var(--color-good)", label: "ok" },
  error: { color: "var(--color-crit-2)", label: "error" },
  unset: { color: "var(--color-ink-3)", label: "unset" },
  running: { color: "var(--color-ink-2)", label: "running" },
};

function Glyph({ status }: { status: StoredTraceStatus }) {
  if (status === "error") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
        <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "unset") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
        <path d="M2 5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "running") {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
        <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
      <path
        d="M1.5 5.5l2.5 2.5L8.5 2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Status is always icon + text, never color alone. */
export function StatusBadge({ status }: { status: StoredTraceStatus }) {
  const s = STYLE[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider"
      style={{ color: s.color }}
    >
      <Glyph status={status} />
      {s.label}
    </span>
  );
}

export function StatusIcon({ status }: { status: StoredTraceStatus }) {
  const s = STYLE[status];
  return (
    <span
      role="img"
      aria-label={s.label}
      title={s.label}
      className="inline-flex shrink-0 items-center"
      style={{ color: s.color }}
    >
      <Glyph status={status} />
    </span>
  );
}
