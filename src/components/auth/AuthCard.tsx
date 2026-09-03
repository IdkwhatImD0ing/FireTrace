import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "@/components/Brand";

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="card reveal p-8">
      <Link href="/" className="inline-flex" aria-label="FireTrace home">
        <Brand />
      </Link>
      <h1 className="mt-8 font-display text-4xl leading-[1.05] text-ink">{title}</h1>
      <p className="mt-2 text-sm text-ink-2">{subtitle}</p>
      <div className="mt-8">{children}</div>
      {footer && <div className="mt-6 border-t border-line pt-5 text-sm text-ink-2">{footer}</div>}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit-2"
    >
      {message}
    </p>
  );
}
