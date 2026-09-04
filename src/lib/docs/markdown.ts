/**
 * A small Markdown parser for the documentation under docs/. It covers the
 * subset those files use (ATX headings, paragraphs, fenced code blocks
 * including inside list items, ordered and unordered lists with nesting,
 * pipe tables, inline code, links, autolinks, bold and italic) and produces
 * a plain AST that src/lib/docs/render.tsx turns into React elements. No
 * raw HTML is ever emitted, so the renderer never needs dangerouslySetInnerHTML.
 */
export type Inline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: number; children: Inline[]; id: string }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] };

export interface TocEntry {
  id: string;
  level: number;
  text: string;
}

const FENCE = /^(\s*)(`{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** GitHub-style heading anchors: lowercase, punctuation dropped, spaces to hyphens. */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => (n.type === "text" || n.type === "code" ? n.value : inlineText(n.children)))
    .join("");
}

// ---------------------------------------------------------------- inline

/** Split on unescaped, un-backticked characters; used for table cells. */
function splitCells(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && line[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  // A leading and trailing pipe produce empty edge cells; drop them.
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", value: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Code spans: one or more backticks, closed by the same run length.
    if (ch === "`") {
      let run = 0;
      while (src[i + run] === "`") run++;
      const close = src.indexOf("`".repeat(run), i + run);
      if (close !== -1 && src[close + run] !== "`") {
        flush();
        let value = src.slice(i + run, close);
        if (value.startsWith(" ") && value.endsWith(" ") && value.trim())
          value = value.slice(1, -1);
        out.push({ type: "code", value });
        i = close + run;
        continue;
      }
    }

    // Links: [text](href "title")
    if (ch === "[") {
      const close = matchingBracket(src, i);
      if (close !== -1 && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        if (end !== -1) {
          const label = src.slice(i + 1, close);
          const target =
            src
              .slice(close + 2, end)
              .trim()
              .split(/\s+/)[0] ?? "";
          flush();
          out.push({ type: "link", href: target, children: parseInline(label) });
          i = end + 1;
          continue;
        }
      }
    }

    // Autolinks: <https://...>
    if (ch === "<") {
      const m = /^<(https?:\/\/[^\s<>]+)>/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ type: "link", href: m[1], children: [{ type: "text", value: m[1] }] });
        i += m[0].length;
        continue;
      }
    }

    // Strong: **text** or __text__
    if ((ch === "*" || ch === "_") && src[i + 1] === ch) {
      const marker = ch + ch;
      const close = src.indexOf(marker, i + 2);
      if (close !== -1 && close > i + 2) {
        flush();
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
      text += marker;
      i += 2;
      continue;
    }

    // Emphasis: *text* or _text_ (underscore only at word boundaries).
    if (ch === "*" || (ch === "_" && (i === 0 || /\s|\(/.test(src[i - 1])))) {
      const close = findEmphasisClose(src, i + 1, ch);
      if (close !== -1) {
        flush();
        out.push({ type: "em", children: parseInline(src.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    // Backslash escapes for the characters we treat specially.
    if (ch === "\\" && i + 1 < src.length && "\\`*_[]()<>|#".includes(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

function matchingBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "`") {
      const close = src.indexOf("`", i + 1);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findEmphasisClose(src: string, from: number, marker: string): number {
  if (src[from] === " " || src[from] === undefined || src[from] === marker) return -1;
  for (let i = from + 1; i < src.length; i++) {
    if (src[i] === "`") {
      const close = src.indexOf("`", i + 1);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (src[i] === marker && src[i - 1] !== " " && src[i + 1] !== marker) {
      if (marker === "_" && i + 1 < src.length && /[\p{L}\p{N}]/u.test(src[i + 1])) continue;
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------- blocks

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

export function parseMarkdown(src: string): Block[] {
  const ids = new Map<string, number>();
  const blocks = parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
  assignHeadingIds(blocks, ids);
  return blocks;
}

function assignHeadingIds(blocks: Block[], seen: Map<string, number>): void {
  for (const block of blocks) {
    if (block.type === "heading") {
      const base = slugifyHeading(inlineText(block.children)) || "section";
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      block.id = count === 0 ? base : `${base}-${count}`;
    } else if (block.type === "list") {
      for (const item of block.items) assignHeadingIds(item, seen);
    }
  }
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const marker = fence[2];
      const lang = fence[3];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const candidate = lines[i];
        const closing = FENCE.exec(candidate);
        if (
          closing &&
          closing[2].startsWith(marker) &&
          closing[3] === "" &&
          candidate.trim() === closing[2]
        ) {
          i++;
          break;
        }
        body.push(candidate.slice(Math.min(indent, indentOf(candidate))));
        i++;
      }
      blocks.push({ type: "code", lang, text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        children: parseInline(heading[2]),
        id: "",
      });
      i++;
      continue;
    }

    if (
      line.trimStart().startsWith("|") &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR.test(lines[i + 1])
    ) {
      const header = splitCells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        rows.push(splitCells(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const markerIndent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const start = ordered ? parseInt(item[2], 10) : 1;
      const items: Block[][] = [];
      while (i < lines.length) {
        const current = LIST_ITEM.exec(lines[i]);
        if (!current || current[1].length !== markerIndent || /\d/.test(current[2]) !== ordered)
          break;
        const contentIndent = markerIndent + current[2].length + 1;
        const itemLines = [current[3]];
        i++;
        // Continuation: blank lines, or lines indented past the marker.
        while (i < lines.length) {
          const next = lines[i];
          if (next.trim() === "") {
            // Keep the blank only if indented content follows (loose item).
            const after = lines.slice(i + 1).find((l) => l.trim() !== "");
            if (after !== undefined && indentOf(after) > markerIndent) {
              itemLines.push("");
              i++;
              continue;
            }
            break;
          }
          if (indentOf(next) > markerIndent) {
            itemLines.push(next.slice(Math.min(contentIndent, indentOf(next))));
            i++;
            continue;
          }
          break;
        }
        items.push(parseBlocks(itemLines));
        // Skip blank lines between sibling items.
        while (i < lines.length && lines[i].trim() === "") {
          const after = lines.slice(i + 1).find((l) => l.trim() !== "");
          const sibling = after !== undefined && LIST_ITEM.exec(after);
          if (sibling && sibling[1].length === markerIndent) i++;
          else break;
        }
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    // Paragraph: consecutive lines until a blank line or another block start.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === "") break;
      if (para.length > 0 && (FENCE.test(l) || HEADING.test(l) || LIST_ITEM.test(l))) break;
      if (
        para.length > 0 &&
        l.trimStart().startsWith("|") &&
        i + 1 < lines.length &&
        TABLE_SEPARATOR.test(lines[i + 1])
      )
        break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join(" ")) });
  }
  return blocks;
}

/** Second- and third-level headings, for an "on this page" list. */
export function tableOfContents(blocks: Block[]): TocEntry[] {
  const out: TocEntry[] = [];
  for (const block of blocks) {
    if (block.type === "heading" && (block.level === 2 || block.level === 3)) {
      out.push({ id: block.id, level: block.level, text: inlineText(block.children) });
    }
  }
  return out;
}

/** The first top-level heading's text, or null. */
export function documentTitle(blocks: Block[]): string | null {
  const h1 = blocks.find((b) => b.type === "heading" && b.level === 1);
  return h1 && h1.type === "heading" ? inlineText(h1.children) : null;
}

/** Apply `fn` to every link href in the tree (used to rewrite relative .md links). */
export function mapLinks(blocks: Block[], fn: (href: string) => string): Block[] {
  const inl = (nodes: Inline[]): Inline[] =>
    nodes.map((n) => {
      if (n.type === "link") return { ...n, href: fn(n.href), children: inl(n.children) };
      if (n.type === "strong" || n.type === "em") return { ...n, children: inl(n.children) };
      return n;
    });
  return blocks.map((b) => {
    switch (b.type) {
      case "heading":
      case "paragraph":
        return { ...b, children: inl(b.children) };
      case "list":
        return { ...b, items: b.items.map((item) => mapLinks(item, fn)) };
      case "table":
        return { ...b, header: b.header.map(inl), rows: b.rows.map((r) => r.map(inl)) };
      default:
        return b;
    }
  });
}
