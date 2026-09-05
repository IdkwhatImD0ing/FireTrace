/**
 * In-project navigation: the sidebar stays put; the content column shows this
 * until the page streams in.
 *
 * Like the dashboard-level `loading.tsx` above it, this boundary commits a
 * 200 before a page can call `notFound()`, so a missing trace or project is a
 * streamed 404 view with `noindex`, not a 404 status (the dashboard is
 * session-gated and `noindex` anyway; the e2e suite accepts either status).
 * Route handlers under /api are not streamed and keep real status codes.
 */
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
