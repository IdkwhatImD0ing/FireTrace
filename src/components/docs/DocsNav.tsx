"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_GROUPS, DOCS } from "@/lib/docs/registry";

/** Sidebar listing every doc by group; highlights the current page. */
export function DocsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation" className="space-y-6">
      <Link
        href="/docs"
        className={`block font-mono text-[12px] uppercase tracking-wider ${
          pathname === "/docs" ? "text-ember-2" : "text-ink-2 hover:text-ink"
        }`}
        aria-current={pathname === "/docs" ? "page" : undefined}
      >
        Overview
      </Link>
      {DOC_GROUPS.map((group) => (
        <div key={group}>
          <p className="mono-label mb-2">{group}</p>
          <ul className="space-y-1">
            {DOCS.filter((d) => d.group === group).map((doc) => {
              const href = `/docs/${doc.slug}`;
              const active = pathname === href;
              return (
                <li key={doc.slug}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded-md px-2 py-1 text-sm ${
                      active
                        ? "bg-ember-dim text-ember-2"
                        : "text-ink-2 hover:bg-surface-2 hover:text-ink"
                    }`}
                  >
                    {doc.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
