const WIDTH = 120;
const HEIGHT = 32;

/** A small trend line; the numbers it summarizes are in the card next to it. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1e-9, ...values);
  const step = WIDTH / Math.max(1, values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(HEIGHT - 1 - (v / max) * (HEIGHT - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      role="img"
      aria-label={label}
      className="shrink-0"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-ember)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
