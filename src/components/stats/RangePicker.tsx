import Link from "next/link";
import { STATS_RANGES, type StatsRange } from "@/lib/firetrace/stats";

const LABELS: Record<StatsRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "14d": "14 days",
  "30d": "30 days",
  "90d": "90 days",
};

/** Links, so the range lives in the URL and can be bookmarked. */
export function RangePicker({ base, range }: { base: string; range: StatsRange }) {
  return (
    <nav aria-label="Time range" className="flex flex-wrap gap-1">
      {STATS_RANGES.map((r) => (
        <Link
          key={r}
          href={r === "7d" ? base : `${base}?range=${r}`}
          aria-current={r === range ? "page" : undefined}
          className={`btn btn-sm ${r === range ? "btn-primary" : "btn-ghost"}`}
        >
          {LABELS[r]}
        </Link>
      ))}
    </nav>
  );
}
