"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { CopyButton } from "@/components/ui/CopyButton";

export interface CodeSample {
  /** Tab label, e.g. "cURL" or "TypeScript SDK". */
  label: string;
  code: string;
}

/**
 * Tabbed code samples: the same call shown in several languages, with one copy
 * button for whichever tab is open. A single sample renders as a labelled block.
 */
export function CodeGroup({ samples, label }: { samples: CodeSample[]; label: string }) {
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

  return (
    // No margin utility here: `.doc-code` supplies one, and a utility would win
    // over the reset that makes a group sit flush inside a <Disclosure>.
    <div className="doc-code">
      <div className="doc-code-bar gap-2">
        <div ref={listRef} role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex">
          {samples.map((sample, i) => (
            <button
              key={sample.label}
              type="button"
              role="tab"
              id={`${baseId}-tab-${i}`}
              aria-selected={i === active}
              aria-controls={`${baseId}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              className={`rounded px-2 py-0.5 font-mono text-[11px] tracking-wider uppercase transition-colors ${
                i === active ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink-2"
              }`}
            >
              {sample.label}
            </button>
          ))}
        </div>
        <CopyButton text={current.code} className="btn btn-ghost btn-sm" />
      </div>
      {samples.map((sample, i) => (
        <pre
          key={sample.label}
          role="tabpanel"
          id={`${baseId}-panel-${i}`}
          aria-labelledby={`${baseId}-tab-${i}`}
          hidden={i !== active}
          // Long samples scroll sideways and hold nothing focusable, so the
          // panel itself has to be reachable for a keyboard user to scroll it.
          tabIndex={0}
        >
          <code>{sample.code}</code>
        </pre>
      ))}
    </div>
  );
}
