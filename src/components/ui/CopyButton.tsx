"use client";

import { useState } from "react";

export function CopyButton({
  text,
  label = "Copy",
  className = "btn btn-ghost btn-sm",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1600);
  }

  return (
    <button type="button" onClick={copy} className={className} aria-live="polite">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}
