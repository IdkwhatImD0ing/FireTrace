"use client";

import { useEffect, useState } from "react";

export interface TocItem {
  id: string;
  text: string;
  /** 2 or 3; level 3 entries are indented. */
  level: number;
}

/**
 * The right-hand section list, shared by the introduction and every rendered
 * doc. It marks the heading the reader is currently under: the last one whose
 * top has passed beneath the sticky header, which is stabler while scrolling
 * than reacting to whichever heading last crossed an observer threshold.
 */
export function OnThisPage({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");

  useEffect(() => {
    const headings = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    // A handful of rect reads in a passive listener, with no writes in between,
    // so this needs no frame throttle of its own.
    const update = () => {
      // 96px clears the sticky header plus a little breathing room.
      const cutoff = 96;
      let current = headings[0];
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= cutoff) current = heading;
        else break;
      }
      // At the very bottom the last section may be too short to reach the
      // cutoff, so bottoming out selects it.
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4) {
        current = headings[headings.length - 1];
      }
      setActive(current.id);
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [items]);

  return (
    <>
      <p className="mono-label mb-2">On this page</p>
      <ul className="space-y-1 border-l border-line text-sm">
        {items.map((item) => (
          <li key={item.id} className={item.level === 3 ? "pl-6" : "pl-3"}>
            <a
              href={`#${item.id}`}
              aria-current={item.id === active ? "location" : undefined}
              className={`-ml-px block border-l-2 py-0.5 pl-2 transition-colors ${
                item.id === active
                  ? "border-ember text-ember-2"
                  : "border-transparent text-ink-2 hover:text-ink"
              }`}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
