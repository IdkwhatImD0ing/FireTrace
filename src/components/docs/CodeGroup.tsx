"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Code } from "@/components/docs/Code";
import { Icon, type IconName } from "@/components/docs/Icons";
import { CopyButton } from "@/components/ui/CopyButton";

export interface CodeSample {
  /** Tab label, e.g. "cURL" or "TypeScript SDK". */
  label: string;
  /** Language for highlighting; see src/lib/docs/highlight.ts. */
  lang: string;
  code: string;
  /** Tiles only: icon and one-line description of what this option involves. */
  icon?: IconName;
  hint?: string;
}

/**
 * Code samples with one selector, shown either as a tab strip above the block
 * ("tabs") or as a grid of option tiles above it ("tiles"). Both are one
 * tablist: roving tabindex, arrow keys, Home/End, and a copy button for
 * whichever sample is open.
 */
export function CodeGroup({
  samples,
  label,
  variant = "tabs",
}: {
  samples: CodeSample[];
  label: string;
  variant?: "tabs" | "tiles";
}) {
  const baseId = useId();
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // `active` is only ever set from an index into this array, so this cannot be
  // undefined for a non-empty one; an empty group has nothing to render.
  const current: CodeSample | undefined = samples[active];

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const next: Record<string, number> = {
      ArrowRight: active + 1,
      ArrowLeft: active - 1,
      Home: 0,
      End: samples.length - 1,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    const index = (next[e.key] + samples.length) % samples.length;
    setActive(index);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  }

  if (!current) return null;

  const tabProps = (i: number) => ({
    type: "button" as const,
    role: "tab",
    id: `${baseId}-tab-${i}`,
    "aria-selected": i === active,
    "aria-controls": `${baseId}-panel-${i}`,
    tabIndex: i === active ? 0 : -1,
    onClick: () => setActive(i),
  });

  const panels = samples.map((sample, i) => (
    <pre
      key={sample.label}
      role="tabpanel"
      id={`${baseId}-panel-${i}`}
      aria-labelledby={`${baseId}-tab-${i}`}
      hidden={i !== active}
      // Long samples scroll sideways and hold nothing focusable, so the panel
      // itself has to be reachable for a keyboard user to scroll it.
      tabIndex={0}
    >
      <Code code={sample.code} lang={sample.lang} />
    </pre>
  ));

  if (variant === "tiles") {
    return (
      <div>
        <div
          ref={listRef}
          role="tablist"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
        >
          {samples.map((sample, i) => (
            <button
              key={sample.label}
              {...tabProps(i)}
              className={`rounded-md border p-3 text-left transition-colors ${
                i === active
                  ? "border-ember bg-ember-dim text-ink"
                  : "border-line bg-bg-2 text-ink-2 hover:border-line-2 hover:bg-surface-2"
              }`}
            >
              {sample.icon && (
                <Icon name={sample.icon} className={i === active ? "text-ember-2" : "text-ink-3"} />
              )}
              <span className="mt-2 block text-sm font-medium text-ink">{sample.label}</span>
              {sample.hint && <span className="block text-xs text-ink-3">{sample.hint}</span>}
            </button>
          ))}
        </div>
        <div className="doc-code">
          <div className="doc-code-bar gap-2">
            <span className="font-mono text-[12px] text-ink-3">{current.label}</span>
            <CopyButton text={current.code} className="btn btn-ghost btn-sm" />
          </div>
          {panels}
        </div>
      </div>
    );
  }

  return (
    // No margin utility here: `.doc-code` supplies one, and a utility would win
    // over the reset that makes a group sit flush inside a <Disclosure>.
    <div className="doc-code">
      <div className="doc-code-bar gap-2">
        <div ref={listRef} role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex">
          {samples.map((sample, i) => (
            <button
              key={sample.label}
              {...tabProps(i)}
              className={`rounded px-2 py-1 font-mono text-[12px] transition-colors ${
                i === active ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {sample.label}
            </button>
          ))}
        </div>
        <CopyButton text={current.code} className="btn btn-ghost btn-sm" />
      </div>
      {panels}
    </div>
  );
}
