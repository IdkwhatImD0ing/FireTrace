import { useId } from "react";

export function Brand({ size = 28, wordmark = true }: { size?: number; wordmark?: boolean }) {
  const gradientId = useId();
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffb27a" />
            <stop offset="1" stopColor="#d95926" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill={`url(#${gradientId})`} />
        <rect x="7" y="9" width="18" height="3" rx="1.5" fill="#1a0d04" />
        <rect x="10" y="15" width="10" height="3" rx="1.5" fill="#1a0d04" />
        <rect x="14" y="21" width="11" height="3" rx="1.5" fill="#1a0d04" />
      </svg>
      {wordmark && (
        <span className="font-display text-[1.4rem] leading-none tracking-tight text-ink">
          Fire<em className="text-ember-2">Trace</em>
        </span>
      )}
    </span>
  );
}
