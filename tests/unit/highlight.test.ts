import { describe, expect, it } from "vitest";
import { TOKEN_CLASS, tokenize, type Token, type TokenKind } from "@/lib/docs/highlight";

/** The rendered text must always be the input, whatever the tokenizer decides. */
function roundTrip(code: string, lang: string): string {
  return tokenize(code, lang)
    .map((t) => t.value)
    .join("");
}

function kindsOf(tokens: Token[], value: string): TokenKind[] {
  return tokens.filter((t) => t.value === value).map((t) => t.kind);
}

describe("code highlighting", () => {
  const samples: [string, string][] = [
    ["json", '{\n  "a": 1,\n  "b": [true, null, "x"]\n}'],
    ["bash", 'curl -s -X POST https://x/y \\\n  -H "A: b" \\\n  -d \'{"n": 1}\'  # note'],
    ["ts", 'import { A } from "b";\n// c\nconst x = await f(`t${1}`);'],
    ["http", "POST /api/v1/traces\nAuthorization: Bearer x"],
    ["text", "just words"],
    ["", "no language"],
    ["rust", "fn main() {}"],
  ];

  it.each(samples)("%s: never loses or invents a character", (lang, code) => {
    expect(roundTrip(code, lang)).toBe(code);
  });

  it.each(samples)("%s: only emits kinds the renderer has a class for", (lang, code) => {
    for (const token of tokenize(code, lang)) {
      expect(Object.keys(TOKEN_CLASS)).toContain(token.kind);
    }
  });

  it("leaves an unknown language as a single plain token", () => {
    expect(tokenize("fn main() {}", "rust")).toEqual([{ kind: "plain", value: "fn main() {}" }]);
    expect(tokenize("just words", "text")).toEqual([{ kind: "plain", value: "just words" }]);
  });

  it("separates JSON keys from string values", () => {
    const tokens = tokenize('{"a": "b"}', "json");
    expect(kindsOf(tokens, '"a"')).toEqual(["property"]);
    expect(kindsOf(tokens, '"b"')).toEqual(["string"]);
    expect(kindsOf(tokens, "true")).toEqual([]);
  });

  it("marks JSON numbers and literals", () => {
    const tokens = tokenize('{"n": 1.5, "t": true, "z": null}', "json");
    expect(kindsOf(tokens, "1.5")).toEqual(["number"]);
    expect(kindsOf(tokens, "true")).toEqual(["literal"]);
    expect(kindsOf(tokens, "null")).toEqual(["literal"]);
  });

  it("marks the shell command but not its arguments", () => {
    const tokens = tokenize("curl -s https://x\nclaude mcp add", "bash");
    expect(kindsOf(tokens, "curl")).toEqual(["command"]);
    expect(kindsOf(tokens, "claude")).toEqual(["command"]);
    // A continued line's first word is an argument, not a new command.
    const continued = tokenize('curl -s \\\n  -H "A: b"', "bash");
    expect(continued.some((t) => t.kind === "command" && t.value !== "curl")).toBe(false);
  });

  it("colours a JSON body inside a quoted shell argument", () => {
    const tokens = tokenize(`curl -d '{"a": 1}'`, "bash");
    expect(kindsOf(tokens, '"a"')).toEqual(["property"]);
    expect(kindsOf(tokens, "1")).toEqual(["number"]);
  });

  it("marks shell comments and variables", () => {
    const tokens = tokenize("# a note\ncurl -H $TOKEN", "bash");
    expect(kindsOf(tokens, "# a note")).toEqual(["comment"]);
    expect(kindsOf(tokens, "$TOKEN")).toEqual(["number"]);
  });

  it("marks TypeScript comments, strings and keywords", () => {
    const tokens = tokenize('// note\nconst a = await f("s");', "ts");
    expect(kindsOf(tokens, "// note")).toEqual(["comment"]);
    expect(kindsOf(tokens, "const")).toEqual(["literal"]);
    expect(kindsOf(tokens, "await")).toEqual(["literal"]);
    expect(kindsOf(tokens, '"s"')).toEqual(["string"]);
    // An identifier that merely contains a keyword is not one.
    expect(tokenize("constant", "ts")).toEqual([{ kind: "plain", value: "constant" }]);
  });

  it("marks the HTTP method and header names", () => {
    const tokens = tokenize("POST /api/v1/traces\nAuthorization: Bearer x", "http");
    expect(kindsOf(tokens, "POST")).toEqual(["command"]);
    expect(kindsOf(tokens, "Authorization")).toEqual(["property"]);
  });

  it("handles an unterminated quote without dropping the tail", () => {
    expect(roundTrip(`echo "unclosed`, "bash")).toBe(`echo "unclosed`);
    expect(roundTrip("const s = 'unclosed", "ts")).toBe("const s = 'unclosed");
  });
});
