/** In-project navigation: the sidebar stays put; the content column shows this until the page streams in. */
export default function ProjectLoading() {
  return (
    <div className="space-y-6" role="status" aria-live="polite">
      <div className="h-3 w-24 animate-pulse rounded bg-surface-3" />
      <div className="h-10 w-64 animate-pulse rounded bg-surface-3" />
      <div className="card h-40 animate-pulse" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
