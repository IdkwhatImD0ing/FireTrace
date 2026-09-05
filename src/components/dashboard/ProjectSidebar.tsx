"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Project navigation: a column on wide screens, a row above the content on narrow ones. */
export function ProjectSidebar({
  projectId,
  projectName,
  showEvaluators,
}: {
  projectId: string;
  projectName: string;
  showEvaluators: boolean;
}) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;
  const items = [
    {
      href: `${base}/dashboard`,
      label: "Dashboard",
      active: pathname.startsWith(`${base}/dashboard`),
    },
    {
      href: base,
      label: "Traces",
      active: pathname === base || pathname.startsWith(`${base}/traces`),
    },
    { href: `${base}/scores`, label: "Scores", active: pathname.startsWith(`${base}/scores`) },
    ...(showEvaluators
      ? [
          {
            href: `${base}/evaluators`,
            label: "Evaluators",
            active: pathname.startsWith(`${base}/evaluators`),
          },
        ]
      : []),
    {
      href: `${base}/settings`,
      label: "Settings",
      active: pathname.startsWith(`${base}/settings`),
    },
  ];

  return (
    <aside className="lg:sticky lg:top-[7.75rem] lg:self-start" aria-label="Project navigation">
      <Link
        href={base}
        className="hidden truncate font-display text-xl leading-tight text-ink hover:underline lg:block"
        title={projectName}
      >
        {projectName}
      </Link>
      <nav aria-label="Project" className="mt-0 lg:mt-3">
        <ul className="flex gap-1 overflow-x-auto lg:flex-col">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                className={`block rounded-md px-3 py-1.5 font-mono text-[12px] uppercase tracking-wider whitespace-nowrap transition-colors ${
                  item.active
                    ? "bg-surface-2 text-ink shadow-[inset_2px_0_0_var(--color-ember)]"
                    : "text-ink-2 hover:bg-surface-2/60 hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
