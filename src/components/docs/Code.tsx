import { TOKEN_CLASS, tokenize } from "@/lib/docs/highlight";

/**
 * Highlighted code. Every token is a text node inside a span, so committed
 * Markdown and stored content can never inject markup.
 */
export function Code({ code, lang }: { code: string; lang: string }) {
  const tokens = tokenize(code, lang);
  return (
    <code>
      {tokens.map((token, i) => {
        const className = TOKEN_CLASS[token.kind];
        return className ? (
          <span key={i} className={className}>
            {token.value}
          </span>
        ) : (
          token.value
        );
      })}
    </code>
  );
}
