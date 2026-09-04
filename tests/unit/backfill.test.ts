import { describe, expect, it } from "vitest";
import { toCandidate } from "../../scripts/backfill-feedback-metadata";

const FAKE = "f".repeat(32);
const TARGET = "42f38ac8295345a7a12c4e3f60d6da23";

describe("toCandidate", () => {
  it("recognises a feedback stand-in and prefixes everything but the pointer", () => {
    expect(
      toCandidate(FAKE, { feedbackFor: TARGET, rating: "up", comment: "helpful" }, "feedback."),
    ).toEqual({
      fakeTraceId: FAKE,
      targetTraceId: TARGET,
      patch: {
        "feedback.rating": "up",
        "feedback.comment": "helpful",
        "feedback.migratedFrom": FAKE,
      },
    });
  });

  it("records where the feedback came from even when it carried nothing else", () => {
    const candidate = toCandidate(FAKE, { feedbackFor: TARGET }, "feedback.");
    expect(candidate?.patch).toEqual({ "feedback.migratedFrom": FAKE });
  });

  it("normalizes an uppercase target id, the way trace ids are matched", () => {
    expect(toCandidate(FAKE, { feedbackFor: TARGET.toUpperCase() }, "f.")?.targetTraceId).toBe(
      TARGET,
    );
  });

  it("honours a custom prefix", () => {
    expect(toCandidate(FAKE, { feedbackFor: TARGET, rating: 1 }, "legacy_")?.patch).toMatchObject({
      legacy_rating: 1,
    });
  });

  it("passes over anything that is not a feedback stand-in", () => {
    expect(toCandidate(FAKE, { route: "/api/chat" }, "feedback.")).toBeNull();
    expect(toCandidate(FAKE, {}, "feedback.")).toBeNull();
    expect(toCandidate(FAKE, null, "feedback.")).toBeNull();
    expect(toCandidate(FAKE, "feedbackFor", "feedback.")).toBeNull();
    expect(toCandidate(FAKE, [{ feedbackFor: TARGET }], "feedback.")).toBeNull();
    // A pointer that is not a trace id is left alone rather than guessed at.
    expect(toCandidate(FAKE, { feedbackFor: "not-a-trace-id" }, "feedback.")).toBeNull();
    expect(toCandidate(FAKE, { feedbackFor: 42 }, "feedback.")).toBeNull();
  });

  it("refuses a trace that points at itself, which would delete the target", () => {
    expect(toCandidate(TARGET, { feedbackFor: TARGET }, "feedback.")).toBeNull();
  });
});
