/**
 * Storage estimate helpers. `estimatedBytes` is FireTrace's own serialized
 * size estimate, not Firebase's billable storage measurement. Warning
 * thresholds default to 70% and 90% of the configured limit (free tier: 1 GiB).
 */
export const FREE_TIER_BYTES = 1024 * 1024 * 1024;
export const WARN_RATIO = 0.7;
export const CRITICAL_RATIO = 0.9;

export type StorageLevel = "ok" | "warning" | "critical";

export function storageLevel(estimatedBytes: number, limitBytes: number): StorageLevel {
  if (limitBytes <= 0) return "ok";
  const ratio = estimatedBytes / limitBytes;
  if (ratio >= CRITICAL_RATIO) return "critical";
  if (ratio >= WARN_RATIO) return "warning";
  return "ok";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function percentOfLimit(estimatedBytes: number, limitBytes: number): number {
  if (limitBytes <= 0) return 0;
  return Math.min(100, Math.round((estimatedBytes / limitBytes) * 1000) / 10);
}
