import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteDocLink } from "@/lib/docs/load";
import {
  documentTitle,
  inlineText,
  mapLinks,
  parseInline,
  parseMarkdown,
  slugifyHeading,
  tableOfContents,
  type Block,
} from "@/lib/docs/markdown";
import { DOCS } from "@/lib/docs/registry";

const docsDir = join(__dirname, "..", "..", "docs");

function walk(blocks: Block[], visit: (b: Block) => void): void {
  for (const b of blocks) {
    visit(b);
    if (b.type === "list") b.items.forEach((item) => walk(item, visit));
  }
}

describe("parseInline", () => {
  it("handles code, links, autolinks, strong, and emphasis", () => {
    const nodes = parseInline(
      "Use `POST /api/v1/traces` with [the SDK](./api.md#sdk), see <https://example.com/x>, **never** *guess*.",
    );
    expect(nodes).toEqual([
      { type: "text", value: "Use " },
      { type: "code", value: "POST /api/v1/traces" },
      { type: "text", value: " with " },
      { type: "link", href: "./api.md#sdk", children: [{ type: "text", value: "the SDK" }] },
      { type: "text", value: ", see " },
      {
        type: "link",
        href: "https://example.com/x",
        children: [{ type: "text", value: "https://example.com/x" }],
      },
      { type: "text", value: ", " },
      { type: "strong", children: [{ type: "text", value: "never" }] },
      { type: "text", value: " " },
      { type: "em", children: [{ type: "text", value: "guess" }] },
      { type: "text", value: "." },
    ]);
  });

  it("does not treat brackets, pipes, or underscores inside code spans as markup", () => {
    const nodes = parseInline(
      "Timestamps match `YYYY-MM-DD[.fraction](Z|±HH:MM)` and `snake_case_name`.",
    );
    expect(nodes.filter((n) => n.type === "link")).toHaveLength(0);
    expect(nodes.find((n) => n.type === "code")).toEqual({
      type: "code",
      value: "YYYY-MM-DD[.fraction](Z|±HH:MM)",
    });
    expect(nodes.filter((n) => n.type === "em")).toHaveLength(0);
  });

  it("leaves lone asterisks, underscores in words, and unmatched markers alone", () => {
    expect(inlineText(parseInline("a * b and snake_case and 2*3"))).toBe(
      "a * b and snake_case and 2*3",
    );
    expect(parseInline("**unterminated")).toEqual([{ type: "text", value: "**unterminated" }]);
  });

  it("supports nested formatting inside links and double-backtick code", () => {
    expect(parseInline("[**bold** link](x.md)")).toEqual([
      {
        type: "link",
        href: "x.md",
        children: [
          { type: "strong", children: [{ type: "text", value: "bold" }] },
          { type: "text", value: " link" },
        ],
      },
    ]);
    expect(parseInline("`` a`b ``")).toEqual([{ type: "code", value: "a`b" }]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings with GitHub-style ids and deduplicates them", () => {
    const blocks = parseMarkdown(
      "# Title\n\n## 5. Authorized domains\n\n### `GET /api/v1/key`\n\n## 5. Authorized domains\n",
    );
    const ids = blocks
      .filter((b) => b.type === "heading")
      .map((b) => (b.type === "heading" ? b.id : ""));
    expect(ids).toEqual([
      "title",
      "5-authorized-domains",
      "get-apiv1key",
      "5-authorized-domains-1",
    ]);
    expect(documentTitle(blocks)).toBe("Title");
    expect(tableOfContents(blocks).map((t) => t.id)).toEqual([
      "5-authorized-domains",
      "get-apiv1key",
      "5-authorized-domains-1",
    ]);
    expect(slugifyHeading("POST /api/v1/traces — scope `traces:write`")).toBe(
      "post-apiv1traces--scope-traceswrite",
    );
  });

  it("parses fenced code blocks, including inside list items, keeping their content verbatim", () => {
    const src = [
      "1. First step:",
      "",
      "   ```bash",
      "   npx -y firebase-tools@latest login",
      "     indented line",
      "   ```",
      "",
      "2. Second step with `code`.",
      "",
      "```json",
      '{ "a": 1 }',
      "```",
    ].join("\n");
    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(2);
    const list = blocks[0];
    if (list.type !== "list") throw new Error("expected list");
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(2);
    expect(list.items[0][0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", value: "First step:" }],
    });
    expect(list.items[0][1]).toEqual({
      type: "code",
      lang: "bash",
      text: "npx -y firebase-tools@latest login\n  indented line",
    });
    expect(list.items[1]).toHaveLength(1);
    expect(blocks[1]).toEqual({ type: "code", lang: "json", text: '{ "a": 1 }' });
  });

  it("parses nested bullet lists and tables with escaped pipes", () => {
    const src = [
      "- top",
      "  - nested one",
      "  - nested `a|b`",
      "- second",
      "",
      "| Code | Meaning |",
      "| --- | --- |",
      "| `a\\|b` | pipe |",
      "| **x** | [y](z.md) |",
    ].join("\n");
    const blocks = parseMarkdown(src);
    const list = blocks[0];
    if (list.type !== "list") throw new Error("expected list");
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    const nested = list.items[0][1];
    if (nested?.type !== "list") throw new Error("expected nested list");
    expect(
      nested.items.map((i) => inlineText(i[0].type === "paragraph" ? i[0].children : [])),
    ).toEqual(["nested one", "nested a|b"]);
    const table = blocks[1];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.header.map(inlineText)).toEqual(["Code", "Meaning"]);
    expect(table.rows.map((r) => r.map(inlineText))).toEqual([
      ["a|b", "pipe"],
      ["x", "y"],
    ]);
    expect(table.rows[1][1][0]).toMatchObject({ type: "link", href: "z.md" });
  });

  it("joins wrapped paragraph lines and stops at block boundaries", () => {
    const blocks = parseMarkdown("line one\nline two\n# Heading\npara after heading\n");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "paragraph"]);
    expect(inlineText(blocks[0].type === "paragraph" ? blocks[0].children : [])).toBe(
      "line one line two",
    );
  });
});

describe("rewriteDocLink", () => {
  const repo = "https://github.com/x/y";
  it("maps sibling docs to routes, repository files to GitHub, and leaves absolute links alone", () => {
    expect(rewriteDocLink("./mcp.md", repo)).toBe("/docs/mcp");
    expect(rewriteDocLink("firebase-setup.md#5-authorized-domains", repo)).toBe(
      "/docs/firebase-setup#5-authorized-domains",
    );
    expect(rewriteDocLink("../SECURITY.md", repo)).toBe(
      "https://github.com/x/y/blob/main/SECURITY.md",
    );
    expect(rewriteDocLink("../README.md#deploy-your-own", repo)).toBe(
      "https://github.com/x/y/blob/main/README.md#deploy-your-own",
    );
    expect(rewriteDocLink("unknown.md", repo)).toBe(
      "https://github.com/x/y/blob/main/docs/unknown.md",
    );
    expect(rewriteDocLink("https://firebase.google.com/docs", repo)).toBe(
      "https://firebase.google.com/docs",
    );
    expect(rewriteDocLink("#anchor", repo)).toBe("#anchor");
  });
});

describe("the committed docs", () => {
  const files = readdirSync(docsDir).filter((f) => f.endsWith(".md"));

  it("are all registered, and every registered file exists", () => {
    expect([...files].sort()).toEqual(DOCS.map((d) => d.file).sort());
  });

  it("parse into blocks with a title, unique heading ids, and no leftover markup", () => {
    for (const doc of DOCS) {
      const blocks = parseMarkdown(readFileSync(join(docsDir, doc.file), "utf8"));
      expect(documentTitle(blocks), doc.file).not.toBeNull();
      const ids: string[] = [];
      walk(blocks, (b) => {
        if (b.type === "heading") ids.push(b.id);
        if (b.type === "paragraph") {
          // Only prose text nodes: code spans legitimately contain brackets and stars.
          const text = b.children
            .filter((n) => n.type === "text")
            .map((n) => (n.type === "text" ? n.value : ""))
            .join("");
          expect(text, `${doc.file}: ${text.slice(0, 60)}`).not.toMatch(/\]\(|\*\*|^#/);
        }
      });
      expect(new Set(ids).size, doc.file).toBe(ids.length);
      expect(ids.length, doc.file).toBeGreaterThan(2);
    }
  });

  it("only link to docs that exist, to repository files, or to absolute URLs", () => {
    const repo = "https://github.com/x/y";
    for (const doc of DOCS) {
      const blocks = mapLinks(
        parseMarkdown(readFileSync(join(docsDir, doc.file), "utf8")),
        (href) => rewriteDocLink(href, repo),
      );
      walk(blocks, (b) => {
        const check = (nodes: Parameters<typeof inlineText>[0]) => {
          for (const n of nodes) {
            if (n.type === "link") {
              expect(n.href, `${doc.file} -> ${n.href}`).toMatch(/^(https?:|\/docs\/|#)/);
              if (n.href.startsWith("/docs/")) {
                const slug = n.href.slice(6).split("#")[0];
                expect(
                  DOCS.some((d) => d.slug === slug),
                  `${doc.file} -> ${n.href}`,
                ).toBe(true);
              }
            }
            if ("children" in n) check(n.children);
          }
        };
        if (b.type === "paragraph" || b.type === "heading") check(b.children);
        if (b.type === "table") [b.header, ...b.rows].flat().forEach(check);
      });
    }
  });
});
