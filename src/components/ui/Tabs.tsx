"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  badge?: string | number;
  content: ReactNode;
}

/** Accessible tabs: roving tabindex, arrow keys, Home/End. */
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
}) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const activeIndex = Math.max(
    0,
    items.findIndex((t) => t.id === value),
  );

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const keys: Record<string, number> = {
      ArrowRight: activeIndex + 1,
      ArrowLeft: activeIndex - 1,
      Home: 0,
      End: items.length - 1,
    };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const next = (keys[e.key] + items.length) % items.length;
    onChange(items[next].id);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus();
  }

  return (
    <div>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Inspector sections"
        onKeyDown={onKeyDown}
        className="flex flex-wrap gap-1 border-b border-line"
      >
        {items.map((item, i) => {
          const selected = i === activeIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.id)}
              className={`-mb-px border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                selected
                  ? "border-ember text-ink"
                  : "border-transparent text-ink-3 hover:text-ink-2"
              }`}
            >
              {item.label}
              {item.badge !== undefined && item.badge !== "" && (
                <span className="ml-1.5 rounded-full bg-surface-3 px-1.5 text-[10px] text-ink-2">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {items.map((item, i) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${baseId}-panel-${item.id}`}
          aria-labelledby={`${baseId}-tab-${item.id}`}
          hidden={i !== activeIndex}
          className="pt-4"
        >
          {i === activeIndex && item.content}
        </div>
      ))}
    </div>
  );
}
