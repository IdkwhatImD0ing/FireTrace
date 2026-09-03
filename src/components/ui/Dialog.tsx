"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Thin wrapper over the native <dialog>: focus trapping, Escape to close and
 * an accessible modal role come from the browser. While `dismissible` is
 * false (an action is in flight) Escape and backdrop clicks are ignored so the
 * React state never drifts from the element state.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  labelledBy,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  labelledBy?: string;
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        if (!dismissible) e.preventDefault();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      aria-labelledby={labelledBy}
      className="card m-auto w-[min(92vw,32rem)] p-0 text-ink backdrop:bg-black/70"
    >
      <div className="p-6" onClick={(e) => e.stopPropagation()}>
        <h2 id={labelledBy} className="font-display text-2xl text-ink">
          {title}
        </h2>
        <div className="mt-4">{children}</div>
      </div>
    </dialog>
  );
}
