import { describe, expect, it } from "vitest";
import { canAccessProject } from "@/lib/auth/access";
import type { Project } from "@/lib/firetrace/types";
import {
  deployYourOwnUrl,
  effectivePlan,
  trialLimitMessage,
  trialSubject,
} from "@/lib/firetrace/trial";

const project: Project = {
  id: "0123456789abcdef01234567",
  name: "alpha",
  slug: "alpha",
  description: "",
  ownerUid: "uid-alpha",
  ownerEmail: "alpha@example.com",
  plan: "trial",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
  lastTraceAt: null,
  traceCount: 0,
  spanCount: 0,
  estimatedBytes: 0,
  settings: { captureContent: true },
};
const ALLOWED = ["owner@example.com"];

describe("canAccessProject", () => {
  it("lets owners open every project", () => {
    expect(canAccessProject({ email: "owner@example.com", role: "owner" }, project, ALLOWED)).toBe(
      true,
    );
    expect(
      canAccessProject(
        { email: "owner@example.com", role: "owner" },
        { ...project, plan: "owner", ownerEmail: null },
        ALLOWED,
      ),
    ).toBe(true);
  });

  it("lets a trial user open only trial projects created under their email", () => {
    const alpha = { email: "alpha@example.com", role: "trial" as const };
    expect(canAccessProject(alpha, project, ALLOWED)).toBe(true);
    expect(canAccessProject({ ...alpha, email: "Alpha@Example.COM" }, project, ALLOWED)).toBe(true);
    expect(canAccessProject({ email: "beta@example.com", role: "trial" }, project, ALLOWED)).toBe(
      false,
    );
    expect(canAccessProject(alpha, { ...project, ownerEmail: null }, ALLOWED)).toBe(false);
  });

  it("does not let a demoted co-owner keep the projects they created as an owner", () => {
    const demoted = { email: "alpha@example.com", role: "trial" as const };
    expect(canAccessProject(demoted, { ...project, plan: "owner" }, ALLOWED)).toBe(false);
  });

  it("treats a trial project whose creator is now allowlisted as an owner project", () => {
    const allowed = ["alpha@example.com"];
    expect(effectivePlan(project, allowed)).toBe("owner");
    expect(canAccessProject({ email: "alpha@example.com", role: "trial" }, project, allowed)).toBe(
      false,
    );
  });
});

describe("effectivePlan and trialSubject", () => {
  it("keeps owner projects as owner and trial projects as trial unless allowlisted", () => {
    expect(effectivePlan({ plan: "owner", ownerEmail: "x@example.com" }, [])).toBe("owner");
    expect(effectivePlan({ plan: "trial", ownerEmail: "x@example.com" }, [])).toBe("trial");
    expect(effectivePlan({ plan: "trial", ownerEmail: null }, ["x@example.com"])).toBe("trial");
    expect(effectivePlan({ plan: "trial", ownerEmail: "X@Example.com" }, ["x@example.com"])).toBe(
      "owner",
    );
  });

  it("derives one stable subject per email regardless of case or spacing", () => {
    const a = trialSubject("Guest@Example.com");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(trialSubject(" guest@example.com ")).toBe(a);
    expect(trialSubject("other@example.com")).not.toBe(a);
  });
});

describe("trial messaging", () => {
  it("points at the README deploy section without a double slash", () => {
    expect(deployYourOwnUrl("https://github.com/x/y/")).toBe(
      "https://github.com/x/y#deploy-your-own",
    );
    expect(deployYourOwnUrl("https://github.com/x/y")).toBe(
      "https://github.com/x/y#deploy-your-own",
    );
  });

  it("explains the cap and links the deploy guide", () => {
    const msg = trialLimitMessage(5, "https://github.com/x/y");
    expect(msg).toContain("5 traces");
    expect(msg).toContain("personal deployment");
    expect(msg).toContain("https://github.com/x/y#deploy-your-own");
    expect(trialLimitMessage(1, "https://github.com/x/y")).toContain("1 trace in total");
    expect(trialLimitMessage(0, "https://github.com/x/y")).toContain("switched off");
  });
});
