import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/ui/CopyButton";
import type { Block, Inline } from "./markdown";

/** Markdown AST to React. Every node is built as an element; no raw HTML. */
export function renderInline(nodes: Inline[], keyPrefix = "i"): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return node.value;
      case "code":
        return <code key={key}>{node.value}</code>;
      case "strong":
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case "link": {
        const external = /^https?:\/\//.test(node.href);
        if (external) {
          return (
            <a key={key} href={node.href} target="_blank" rel="noreferrer">
              {renderInline(node.children, key)}
            </a>
          );
        }
        return (
          <Link key={key} href={node.href}>
            {renderInline(node.children, key)}
          </Link>
        );
      }
    }
  });
}

function Heading({
  block,
  children,
}: {
  block: Extract<Block, { type: "heading" }>;
  children: ReactNode;
}) {
  const props = { id: block.id, className: "group scroll-mt-24" };
  const anchor = (
    <a
      href={`#${block.id}`}
      className="ml-2 font-mono text-[0.7em] text-ink-3 no-underline opacity-0 transition-opacity group-hover:opacity-100"
      aria-hidden="true"
      tabIndex={-1}
    >
      #
    </a>
  );
  switch (block.level) {
    case 1:
      return <h1 {...props}>{children}</h1>;
    case 2:
      return (
        <h2 {...props}>
          {children}
          {anchor}
        </h2>
      );
    case 3:
      return (
        <h3 {...props}>
          {children}
          {anchor}
        </h3>
      );
    case 4:
      return (
        <h4 {...props}>
          {children}
          {anchor}
        </h4>
      );
    default:
      return <h5 {...props}>{children}</h5>;
  }
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  // Prose-like fences (no language, or "text") wrap; real code keeps its lines.
  const wrap = !lang || lang === "text";
  return (
    <div className="doc-code">
      <div className="doc-code-bar">
        <span className="mono-label">{lang || "text"}</span>
        <CopyButton text={text} className="btn btn-ghost btn-sm" />
      </div>
      <pre className={wrap ? "doc-code-wrap" : undefined}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function renderBlocks(blocks: Block[], keyPrefix = "b"): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (block.type) {
      case "heading":
        return (
          <Heading key={key} block={block}>
            {renderInline(block.children, key)}
          </Heading>
        );
      case "paragraph":
        return <p key={key}>{renderInline(block.children, key)}</p>;
      case "code":
        return <CodeBlock key={key} lang={block.lang} text={block.text} />;
      case "list": {
        const items = block.items.map((item, itemIndex) => {
          const itemKey = `${key}-${itemIndex}`;
          // A tight item is a single paragraph: render its inline content directly.
          if (item.length === 1 && item[0].type === "paragraph") {
            return <li key={itemKey}>{renderInline(item[0].children, itemKey)}</li>;
          }
          return <li key={itemKey}>{renderBlocks(item, itemKey)}</li>;
        });
        return block.ordered ? (
          <ol key={key} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "table":
        return (
          <div key={key} className="doc-table">
            <table>
              <thead>
                <tr>
                  {block.header.map((cell, c) => (
                    <th key={c} scope="col">
                      {renderInline(cell, `${key}-h${c}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c}>{renderInline(cell, `${key}-${r}-${c}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}
