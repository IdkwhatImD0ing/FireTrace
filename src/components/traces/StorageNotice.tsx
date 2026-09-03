import { formatBytes, percentOfLimit, storageLevel } from "@/lib/firetrace/storage";

export function StorageNotice({
  estimatedBytes,
  limitBytes,
}: {
  estimatedBytes: number;
  limitBytes: number;
}) {
  const level = storageLevel(estimatedBytes, limitBytes);
  if (level === "ok") return null;
  return (
    <p
      role="status"
      className={`rounded-md border px-3 py-2 text-sm text-ink ${
        level === "critical" ? "border-crit/50 bg-crit/10" : "border-warn/50 bg-warn/10"
      }`}
    >
      This project&apos;s estimated storage is {formatBytes(estimatedBytes)}, about{" "}
      {percentOfLimit(estimatedBytes, limitBytes)}% of the configured {formatBytes(limitBytes)}{" "}
      allowance. Nothing is deleted automatically; delete traces you no longer need or upgrade the
      Firebase plan. The estimate is FireTrace&apos;s own serialized size, not Firebase&apos;s
      billable measurement.
    </p>
  );
}
