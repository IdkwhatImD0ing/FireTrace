import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatOffset,
  formatRelative,
  formatTokens,
  totalTokens,
  truncateId,
} from "@/lib/format";

describe("formatDuration", () => {
  it("renders a dash for missing or non-finite values", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("scales units from sub-millisecond to minutes", () => {
    expect(formatDuration(0)).toBe("0.00 ms");
    expect(formatDuration(0.5)).toBe("0.50 ms");
    expect(formatDuration(1)).toBe("1 ms");
    expect(formatDuration(250.4)).toBe("250 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1000)).toBe("1.00 s");
    expect(formatDuration(1500)).toBe("1.50 s");
    expect(formatDuration(2692)).toBe("2.69 s");
    expect(formatDuration(59_999)).toBe("60.00 s");
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_600_000)).toBe("60m 0s");
  });
});

describe("formatOffset", () => {
  it("prefixes a plus sign and clamps negative offsets to zero", () => {
    expect(formatOffset(1200)).toBe("+1.20 s");
    expect(formatOffset(25)).toBe("+25 ms");
    expect(formatOffset(-40)).toBe("+0.00 ms");
  });
});

describe("formatDateTime", () => {
  it("renders a deterministic UTC timestamp", () => {
    const text = formatDateTime("2026-09-02T19:01:02.120Z");
    expect(text).toContain("Sep 2, 2026");
    expect(text).toContain("19:01:02");
    expect(text.endsWith(" UTC")).toBe(true);
  });

  it("converts offsets to UTC", () => {
    expect(formatDateTime("2026-09-02T21:01:02+02:00")).toBe(
      formatDateTime("2026-09-02T19:01:02Z"),
    );
  });

  it("renders a dash for missing or invalid input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("not a date")).toBe("—");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-09-02T19:01:02.120Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("buckets elapsed time into human units", () => {
    expect(formatRelative(ago(0), now)).toBe("just now");
    expect(formatRelative(ago(44 * SECOND), now)).toBe("just now");
    expect(formatRelative(ago(45 * SECOND), now)).toBe("1m ago");
    expect(formatRelative(ago(5 * MINUTE), now)).toBe("5m ago");
    expect(formatRelative(ago(59 * MINUTE), now)).toBe("59m ago");
    expect(formatRelative(ago(3 * HOUR), now)).toBe("3h ago");
    expect(formatRelative(ago(2 * DAY), now)).toBe("2d ago");
    expect(formatRelative(ago(29 * DAY), now)).toBe("29d ago");
    expect(formatRelative(ago(45 * DAY), now)).toBe("2mo ago");
    expect(formatRelative(ago(400 * DAY), now)).toBe("1y ago");
    expect(formatRelative(ago(3 * 365 * DAY), now)).toBe("3y ago");
  });

  it("treats future timestamps as just now", () => {
    expect(formatRelative(ago(-HOUR), now)).toBe("just now");
  });

  it("renders a dash for missing or invalid input", () => {
    expect(formatRelative(null, now)).toBe("—");
    expect(formatRelative(undefined, now)).toBe("—");
    expect(formatRelative("garbage", now)).toBe("—");
  });
});

describe("formatTokens", () => {
  it("groups thousands and dashes missing values", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(508)).toBe("508");
    expect(formatTokens(1234567)).toBe("1,234,567");
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
  });
});

describe("formatCost", () => {
  it("uses more precision for smaller amounts", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.0012)).toBe("$0.00120");
    expect(formatCost(0.005)).toBe("$0.00500");
    expect(formatCost(0.5)).toBe("$0.5000");
    expect(formatCost(0.0375)).toBe("$0.0375");
    expect(formatCost(2.5)).toBe("$2.50");
    expect(formatCost(1234)).toBe("$1234.00");
  });

  it("renders a dash for missing or non-finite values", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(undefined)).toBe("—");
    expect(formatCost(Number.NaN)).toBe("—");
    expect(formatCost(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("totalTokens", () => {
  it("prefers an explicit total, otherwise sums the parts", () => {
    expect(totalTokens({ inputTokens: 1, outputTokens: 2, totalTokens: 10 })).toBe(10);
    expect(totalTokens({ inputTokens: 120, outputTokens: 84 })).toBe(204);
    expect(totalTokens({ inputTokens: 120 })).toBe(120);
    expect(totalTokens({ outputTokens: 84 })).toBe(84);
    expect(totalTokens({ totalTokens: 0 })).toBe(0);
  });

  it("returns null when nothing is known", () => {
    expect(totalTokens(null)).toBeNull();
    expect(totalTokens(undefined)).toBeNull();
    expect(totalTokens({})).toBeNull();
  });
});

describe("truncateId", () => {
  it("keeps short ids intact and elides the middle of long ones", () => {
    expect(truncateId("00f067aa0ba902b7")).toBe("00f067aa0ba902b7");
    expect(truncateId("42f38ac8295345a7a12c4e3f60d6da23")).toBe("42f38ac8…da23");
    expect(truncateId("00f067aa0ba902b7", 4)).toBe("00f0…02b7");
    expect(truncateId("", 4)).toBe("");
  });
});
