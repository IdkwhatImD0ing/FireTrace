import { BarChart } from "@/components/stats/BarChart";
import type { ProjectStats } from "@/lib/firetrace/stats";

/**
 * Traces per day for the last two weeks above the list, from the dashboard's
 * rollups (the page loads them together with the list). Each bar links to the
 * list filtered to that day.
 */
export function TraceHistogram({ projectId, stats }: { projectId: string; stats: ProjectStats }) {
  if (stats.days === 0) return null;
  return (
    <BarChart
      title="Traces per day · last 14 days · errors in red · click a bar to filter"
      points={stats.series.map((p) => ({
        key: p.key,
        label: p.label,
        value: p.traces,
        errors: p.errors,
        href: `/projects/${projectId}?from=${p.key}T00:00&to=${p.key}T23:59`,
      }))}
      format={(v) => `${v.toLocaleString("en-US")} traces`}
    />
  );
}
