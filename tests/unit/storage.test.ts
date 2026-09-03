import { describe, expect, it } from "vitest";
import {
  CRITICAL_RATIO,
  formatBytes,
  FREE_TIER_BYTES,
  percentOfLimit,
  storageLevel,
  WARN_RATIO,
} from "@/lib/firetrace/storage";

const GIB = 1024 * 1024 * 1024;

describe("constants", () => {
  it("matches the free-tier allowance and warning thresholds", () => {
    expect(FREE_TIER_BYTES).toBe(GIB);
    expect(WARN_RATIO).toBe(0.7);
    expect(CRITICAL_RATIO).toBe(0.9);
  });
});

describe("storageLevel", () => {
  it("is ok below 70% of the limit", () => {
    expect(storageLevel(0, GIB)).toBe("ok");
    expect(storageLevel(GIB * 0.5, GIB)).toBe("ok");
    expect(storageLevel(Math.floor(GIB * 0.7) - 1, GIB)).toBe("ok");
  });

  it("warns from 70% up to 90%", () => {
    expect(storageLevel(GIB * 0.7, GIB)).toBe("warning");
    expect(storageLevel(GIB * 0.8, GIB)).toBe("warning");
    expect(storageLevel(Math.floor(GIB * 0.9) - 1, GIB)).toBe("warning");
  });

  it("is critical from 90% and beyond the limit", () => {
    expect(storageLevel(GIB * 0.9, GIB)).toBe("critical");
    expect(storageLevel(GIB, GIB)).toBe("critical");
    expect(storageLevel(GIB * 3, GIB)).toBe("critical");
  });

  it("respects a configurable limit", () => {
    expect(storageLevel(700, 1000)).toBe("warning");
    expect(storageLevel(699, 1000)).toBe("ok");
    expect(storageLevel(900, 1000)).toBe("critical");
  });

  it("treats a non-positive limit as unlimited", () => {
    expect(storageLevel(GIB * 10, 0)).toBe("ok");
    expect(storageLevel(GIB * 10, -1)).toBe("ok");
  });
});

describe("formatBytes", () => {
  it("renders bytes below one KiB verbatim", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("scales binary units with precision that shrinks as the number grows", () => {
    expect(formatBytes(1024)).toBe("1.00 KiB");
    expect(formatBytes(1536)).toBe("1.50 KiB");
    expect(formatBytes(10 * 1024)).toBe("10.0 KiB");
    expect(formatBytes(100 * 1024)).toBe("100 KiB");
    expect(formatBytes(1023 * 1024)).toBe("1023 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.00 MiB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.50 MiB");
    expect(formatBytes(GIB)).toBe("1.00 GiB");
    expect(formatBytes(0.7 * GIB)).toBe("717 MiB");
    expect(formatBytes(1024 * GIB)).toBe("1.00 TiB");
  });

  it("stops at TiB instead of inventing larger units", () => {
    expect(formatBytes(5 * 1024 * 1024 * GIB)).toBe("5120 TiB");
  });

  it("renders zero for negative or non-finite input", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("percentOfLimit", () => {
  it("rounds to one decimal place", () => {
    expect(percentOfLimit(0, 1000)).toBe(0);
    expect(percentOfLimit(3, 1000)).toBe(0.3);
    expect(percentOfLimit(123, 1000)).toBe(12.3);
    expect(percentOfLimit(1234, 10000)).toBe(12.3);
    expect(percentOfLimit(0.7 * GIB, GIB)).toBe(70);
  });

  it("clamps at 100 and treats a non-positive limit as zero usage", () => {
    expect(percentOfLimit(1000, 1000)).toBe(100);
    expect(percentOfLimit(1500, 1000)).toBe(100);
    expect(percentOfLimit(500, 0)).toBe(0);
    expect(percentOfLimit(500, -5)).toBe(0);
  });
});
