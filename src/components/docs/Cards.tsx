import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/docs/Icons";

/** Card grid used across the docs. Two columns by default, three when asked. */
export function CardGrid({ columns = 2, children }: { columns?: 2 | 3; children: ReactNode }) {
  return (
    <div
      className={`doc-cards my-5 grid gap-4 sm:grid-cols-2 ${columns === 3 ? "lg:grid-cols-3" : ""}`}
    >
      {children}
    </div>
  );
}

/**
 * A linked card: title, one line of description, whole surface clickable. An
 * absolute overlay on the link keeps a single tab stop and a real link target.
 */
export function DocCard({
  href,
  title,
  eyebrow,
  icon,
  labelPrefix,
  children,
}: {
  href: string;
  title: string;
  eyebrow?: string;
  icon?: IconName;
  /** Folds the eyebrow into the link's accessible name, e.g. "Next: Ingestion API". */
  labelPrefix?: string;
  children?: ReactNode;
}) {
  const external = /^https?:\/\//.test(href);
  const label = (
    <>
      {title}
      {external && <span aria-hidden="true"> ↗</span>}
    </>
  );
  const accessibleName = labelPrefix ? `${labelPrefix}: ${title}` : undefined;
  return (
    <div className="card relative p-4 transition-colors hover:border-line-2 hover:bg-surface-2">
      {icon && <Icon name={icon} className="mb-2 text-ember-2" />}
      {eyebrow && <p className="mono-label mb-1.5">{eyebrow}</p>}
      <h3 className="font-medium text-ink">
        {external ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={accessibleName}
            className="after:absolute after:inset-0"
          >
            {label}
          </a>
        ) : (
          <Link href={href} aria-label={accessibleName} className="after:absolute after:inset-0">
            {label}
          </Link>
        )}
      </h3>
      {children && <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{children}</p>}
    </div>
  );
}
