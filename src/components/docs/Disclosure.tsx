import type { ReactNode } from "react";

/** Collapsed detail — response bodies and long asides that would drown the page. */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="doc-disclosure">
      <summary>{summary}</summary>
      <div className="doc-disclosure-body">{children}</div>
    </details>
  );
}
