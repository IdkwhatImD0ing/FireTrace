import type { ReactNode } from "react";

export function EmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="card px-6 py-12 text-center">
      <h2 className="font-display text-3xl text-ink">{title}</h2>
      <div className="mx-auto mt-2 max-w-lg text-sm text-ink-2">{body}</div>
      {children && <div className="mt-6 flex flex-wrap justify-center gap-3">{children}</div>}
    </div>
  );
}
