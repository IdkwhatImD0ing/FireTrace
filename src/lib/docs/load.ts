import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicRepositoryUrl } from "@/lib/env/server";
import {
  documentTitle,
  mapLinks,
  parseMarkdown,
  tableOfContents,
  type Block,
  type TocEntry,
} from "./markdown";
import { DOCS, findDoc, type DocEntry } from "./registry";

export interface LoadedDoc {
  entry: DocEntry;
  title: string;
  blocks: Block[];
  toc: TocEntry[];
  /** The file on GitHub, for an "edit" link. */
  sourceUrl: string;
}

/**
 * Relative links inside docs/ point at sibling Markdown files or at repository
 * files one level up. Sibling docs become /docs routes (anchors preserved);
 * anything else becomes a link to the file on GitHub.
 */
export function rewriteDocLink(href: string, repoUrl: string): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [pathPart, hash = ""] = href.split("#");
  const anchor = hash ? `#${hash}` : "";
  const relative = pathPart.replace(/^\.\//, "");
  const sibling = /^([\w-]+)\.md$/.exec(relative);
  if (sibling) {
    const doc = DOCS.find((d) => d.file === sibling[0]);
    if (doc) return `/docs/${doc.slug}${anchor}`;
    return `${repoUrl}/blob/main/docs/${relative}${anchor}`;
  }
  if (relative.startsWith("../")) return `${repoUrl}/blob/main/${relative.slice(3)}${anchor}`;
  return `${repoUrl}/blob/main/docs/${relative}${anchor}`;
}

export function loadDoc(slug: string): LoadedDoc | null {
  const entry = findDoc(slug);
  if (!entry) return null;
  const repo = publicRepositoryUrl();
  const source = readFileSync(join(process.cwd(), "docs", entry.file), "utf8");
  const blocks = mapLinks(parseMarkdown(source), (href) => rewriteDocLink(href, repo));
  return {
    entry,
    title: documentTitle(blocks) ?? entry.title,
    blocks,
    toc: tableOfContents(blocks),
    sourceUrl: `${repo}/blob/main/docs/${entry.file}`,
  };
}
