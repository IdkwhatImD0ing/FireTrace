"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Newer / older links in the list's current order; `[` and `]` follow them. */
export function TraceNav({
  newerHref,
  olderHref,
}: {
  newerHref: string | null;
  olderHref: string | null;
}) {
  const router = useRouter();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[" && newerHref) router.push(newerHref);
      if (e.key === "]" && olderHref) router.push(olderHref);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newerHref, olderHref, router]);

  const item = (href: string | null, label: string, hint: string) =>
    href ? (
      <Link href={href} className="btn btn-ghost btn-sm" title={hint}>
        {label}
      </Link>
    ) : (
      <span className="btn btn-ghost btn-sm opacity-40" aria-disabled title={hint}>
        {label}
      </span>
    );

  return (
    <nav aria-label="Neighbouring traces" className="flex gap-1">
      {item(newerHref, "← Newer", "Previous trace in the list ([)")}
      {item(olderHref, "Older →", "Next trace in the list (])")}
    </nav>
  );
}
