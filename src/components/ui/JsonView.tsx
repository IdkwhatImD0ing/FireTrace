import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/CopyButton";

/**
 * Pretty-printed JSON with light syntax highlighting. Everything is rendered
 * as text nodes (React escapes), so stored content can never inject markup.
 */
const TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)/g;

function highlightLine(line: string, key: number): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of line.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(line.slice(last, start));
    const [full, str, colon, num, literal] = match;
    if (str !== undefined) {
      parts.push(
        <span key={i++} className={colon ? "json-key" : "json-string"}>
          {str}
        </span>,
      );
      if (colon) parts.push(colon);
    } else if (num !== undefined) {
      parts.push(
        <span key={i++} className="json-number">
          {num}
        </span>,
      );
    } else if (literal !== undefined) {
      parts.push(
        <span key={i++} className="json-literal">
          {literal}
        </span>,
      );
    } else {
      parts.push(full);
    }
    last = start + full.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return <span key={key}>{parts}</span>;
}

export function stringifyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export function JsonView({
  value,
  emptyLabel = "Not recorded",
  maxHeight = "28rem",
}: {
  value: unknown;
  emptyLabel?: string;
  maxHeight?: string;
}) {
  if (value === null || value === undefined) {
    return <p className="text-sm text-ink-3">{emptyLabel}</p>;
  }
  const text = stringifyJson(value);
  const isPlainString = typeof value === "string";
  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10">
        <CopyButton text={text} label="Copy JSON" />
      </div>
      <pre className="pre overflow-auto" style={{ maxHeight }}>
        {isPlainString
          ? text
          : text.split("\n").map((line, i) => (
              <span key={i} className="block">
                {highlightLine(line, i)}
              </span>
            ))}
      </pre>
    </div>
  );
}
