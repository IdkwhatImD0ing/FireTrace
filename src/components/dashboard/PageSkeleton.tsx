/**
 * Placeholder for a dashboard page while its data streams in. Rendered by the
 * `loading.tsx` of each leaf page segment; the layouts above those boundaries
 * do the existence checks, so a missing project or trace is still a real 404.
 */
export function PageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <div className="h-3 w-24 animate-pulse rounded bg-surface-3" />
      <div className="h-10 w-64 animate-pulse rounded bg-surface-3" />
      <div className="card h-40 animate-pulse" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
