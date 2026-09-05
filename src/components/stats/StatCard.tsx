import { Sparkline } from "./Sparkline";

export function StatCard({
  label,
  value,
  hint,
  series,
}: {
  label: string;
  value: string;
  hint?: string;
  /** One number per bucket of the selected range, oldest first. */
  series?: number[];
}) {
  return (
    <div className="card flex items-start justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="mono-label">{label}</p>
        <p className="mt-1 truncate font-mono text-2xl text-ink">{value}</p>
        {hint && <p className="mt-0.5 font-mono text-[11px] text-ink-3">{hint}</p>}
      </div>
      {series && series.some((v) => v > 0) && (
        <Sparkline values={series} label={`${label} over the selected range`} />
      )}
    </div>
  );
}
