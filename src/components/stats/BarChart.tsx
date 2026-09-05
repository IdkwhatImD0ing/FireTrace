import Link from "next/link";

export interface BarPoint {
  key: string;
  label: string;
  value: number;
  /** Wraps the bar in a link, e.g. to the trace list filtered to that bucket. */
  href?: string;
  /** Portion of `value` drawn in the error colour (stacked on top). */
  errors?: number;
}

/**
 * Bars as flex children rather than SVG, so they stay crisp at any width and
 * every bar keeps a native tooltip. Labels are thinned to roughly eight.
 */
export function BarChart({
  title,
  points,
  format,
}: {
  title: string;
  points: BarPoint[];
  format: (value: number) => string;
}) {
  const max = Math.max(1e-9, ...points.map((p) => p.value));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const peak = points.reduce((best, p) => (p.value > best.value ? p : best), points[0]);
  return (
    <figure className="card p-4">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="mono-label">{title}</span>
        {peak && peak.value > 0 && (
          <span className="font-mono text-[11px] text-ink-3">
            peak {format(peak.value)} · {peak.label}
          </span>
        )}
      </figcaption>
      <div
        className="mt-3 flex h-36 gap-px"
        role="img"
        aria-label={`${title}: ${points.length} buckets, peak ${peak ? format(peak.value) : "0"}`}
      >
        {points.map((p) => {
          const total = (p.value / max) * 100;
          const errors = p.errors ? (Math.min(p.errors, p.value) / max) * 100 : 0;
          const ok = Math.max(total - errors, p.value > 0 && total - errors < 1 ? 1 : 0);
          const column = {
            className: "flex h-full min-w-0 flex-1 flex-col justify-end",
            title: `${p.label}: ${format(p.value)}${p.errors ? ` (${p.errors} with errors)` : ""}`,
          };
          const bars = (
            <>
              {errors > 0 && (
                <div
                  className="rounded-t-[2px]"
                  style={{ height: `${errors}%`, background: "var(--color-crit)" }}
                />
              )}
              <div
                className={errors > 0 ? "" : "rounded-t-[2px]"}
                style={{ height: `${ok}%`, background: "var(--color-ember)" }}
              />
            </>
          );
          return p.href ? (
            <Link key={p.key} href={p.href} {...column}>
              {bars}
            </Link>
          ) : (
            <div key={p.key} {...column}>
              {bars}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-px" aria-hidden>
        {points.map((p, i) => (
          <span key={p.key} className="min-w-0 flex-1 truncate font-mono text-[9px] text-ink-3">
            {i % labelEvery === 0 ? p.label : ""}
          </span>
        ))}
      </div>
    </figure>
  );
}
