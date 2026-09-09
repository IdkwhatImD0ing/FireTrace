import { describe, expect, it } from "vitest";
import {
  FAILING_SPAN,
  FIRST_TRACE,
  HELPFUL_SCORE,
  mcpSamples,
  readSamples,
  recordSamples,
  scoreSamples,
  spanSamples,
} from "@/app/docs/samples";
import { HIGHLIGHTED_LANGUAGES } from "@/lib/docs/highlight";
import { ingestRequestSchema, scoreInputSchema, spanInputSchema } from "@/lib/firetrace/schema";

/**
 * The introduction page at /docs shows copy-paste payloads. They are the first
 * thing a new user runs, so they are checked against the same validators the
 * API uses: a schema change that would make them 400 must fail here first.
 */
describe("introduction page samples", () => {
  it("offers a first trace the ingest endpoint would accept", () => {
    const parsed = ingestRequestSchema.safeParse(FIRST_TRACE);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("offers a failing span the ingest endpoint would accept", () => {
    const parsed = spanInputSchema.safeParse(FAILING_SPAN);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("offers a score the scores endpoint would accept", () => {
    const parsed = scoreInputSchema.safeParse(HELPFUL_SCORE);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("embeds those payloads in the shell commands rather than a second copy", () => {
    const curl = recordSamples("https://example.test").find((s) => s.label === "cURL");
    expect(curl?.code).toContain(FIRST_TRACE.trace.id);
    expect(curl?.code).toContain('"schemaVersion": 1');

    const score = scoreSamples("https://example.test").find((s) => s.label === "cURL");
    expect(score?.code).toContain(JSON.stringify(HELPFUL_SCORE));

    const span = spanSamples().find((s) => s.label === "A failing span");
    expect(span?.code).toContain(FAILING_SPAN.id);
  });

  it("labels every sample with a language the highlighter knows", () => {
    const all = [
      ...mcpSamples("https://example.test"),
      ...recordSamples("https://example.test"),
      ...spanSamples(),
      ...readSamples("https://example.test"),
      ...scoreSamples("https://example.test"),
    ];
    for (const sample of all) {
      // "text" is the deliberate opt-out (the agent prompt is prose, not code);
      // anything else must highlight, so a typo cannot silently disable it.
      const known = sample.lang === "text" || HIGHLIGHTED_LANGUAGES.has(sample.lang);
      expect(known, `${sample.label} has lang "${sample.lang}"`).toBe(true);
    }
  });

  it("points every sample at the deployment it was built for", () => {
    const appUrl = "https://traces.example.test";
    const all = [
      ...mcpSamples(appUrl),
      ...recordSamples(appUrl),
      ...readSamples(appUrl),
      ...scoreSamples(appUrl),
    ];
    // No sample may hard-code a deployment; every URL must come from the argument.
    for (const sample of all) {
      expect(sample.code, sample.label).not.toMatch(/https:\/\/(?!example)[\w.-]*firetrace/i);
      expect(sample.code, sample.label).not.toContain("art3m1s");
    }
    expect(all.filter((s) => s.code.includes(appUrl)).length).toBeGreaterThan(4);
  });
});
