import { describe, expect, it } from "vitest";
import { loadDoc } from "@/lib/docs/load";
import { DOCS } from "@/lib/docs/registry";

/** loadDoc feeds both /docs pages: the header takes the title, the body must not repeat it. */
describe("loadDoc", () => {
  it("returns null for an unknown slug", () => {
    expect(loadDoc("not-a-doc")).toBeNull();
  });

  it.each(DOCS.map((d) => d.slug))("%s: lifts the title out of the body", (slug) => {
    const doc = loadDoc(slug);
    expect(doc).not.toBeNull();
    expect(doc!.title.length).toBeGreaterThan(0);
    // The page header renders the title; leaving it in the body would show it twice.
    expect(doc!.blocks.filter((b) => b.type === "heading" && b.level === 1)).toEqual([]);
    // Only the H1 is dropped — everything else survives.
    expect(doc!.blocks.length).toBeGreaterThan(3);
    expect(doc!.toc.every((entry) => entry.level === 2 || entry.level === 3)).toBe(true);
  });

  it.each(DOCS.map((d) => d.slug))("%s: carries the Markdown for the copy button", (slug) => {
    const doc = loadDoc(slug)!;
    expect(doc.source).toContain(`# ${doc.title}`);
    expect(doc.sourceUrl).toContain(doc.entry.file);
  });
});
