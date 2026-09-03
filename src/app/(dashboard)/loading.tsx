export default function DashboardLoading() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <div className="h-3 w-24 animate-pulse rounded bg-surface-3" />
      <div className="h-10 w-64 animate-pulse rounded bg-surface-3" />
      <div className="card h-40 animate-pulse" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
