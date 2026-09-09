/**
 * Syntax highlighting for the code shown in the docs. The docs pipeline has no
 * Markdown dependency and emits no raw HTML, so this is a small tokenizer for
 * the handful of languages the fences actually use (bash, json, ts, http) and
 * the renderer turns its tokens into React elements. Anything it does not know
 * comes back as one plain token, which renders exactly as it does today.
 *
 * Token kinds reuse the palette JsonView already established (`json-*`), so a
 * JSON body looks the same in a doc as it does in the trace inspector.
 */
export type TokenKind =
  "plain" | "comment" | "string" | "number" | "literal" | "property" | "command";

export interface Token {
  kind: TokenKind;
  value: string;
}

export const TOKEN_CLASS: Record<TokenKind, string | undefined> = {
  plain: undefined,
  comment: "tok-comment",
  string: "json-string",
  number: "json-number",
  literal: "json-literal",
  property: "json-key",
  command: "tok-command",
};

/** Languages this module highlights; every other fence stays plain. */
export const HIGHLIGHTED_LANGUAGES = new Set([
  "json",
  "bash",
  "sh",
  "shell",
  "powershell",
  "ts",
  "js",
  "http",
]);

const TS_KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "default",
  "const",
  "let",
  "var",
  "function",
  "return",
  "await",
  "async",
  "new",
  "class",
  "extends",
  "if",
  "else",
  "for",
  "of",
  "in",
  "while",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "type",
  "interface",
]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** Merges adjacent plain tokens so the renderer emits fewer elements. */
function pushToken(out: Token[], kind: TokenKind, value: string): void {
  if (!value) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind && kind === "plain") last.value += value;
  else out.push({ kind, value });
}

// ------------------------------------------------------------------- json

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

function tokenizeJson(code: string, out: Token[] = []): Token[] {
  let last = 0;
  for (const match of code.matchAll(JSON_TOKEN)) {
    const start = match.index;
    pushToken(out, "plain", code.slice(last, start));
    const [full, str, colon, num, literal] = match;
    if (str !== undefined) {
      // A string followed by a colon is a key, matching JsonView.
      pushToken(out, colon ? "property" : "string", str);
      if (colon) pushToken(out, "plain", colon);
    } else if (num !== undefined) {
      pushToken(out, "number", num);
    } else if (literal !== undefined) {
      pushToken(out, "literal", literal);
    } else {
      pushToken(out, "plain", full);
    }
    last = start + full.length;
  }
  pushToken(out, "plain", code.slice(last));
  return out;
}

// ------------------------------------------------------------------- shell

/** True where a word is the command being run rather than one of its arguments. */
function atCommandPosition(code: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = code[i];
    if (ch === " " || ch === "\t") continue;
    if (ch === "\n" || ch === "|" || ch === "&" || ch === ";" || ch === "(") return true;
    // A backslash-newline continues the previous command, so this is an argument.
    return false;
  }
  return true;
}

function tokenizeShell(code: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    pushToken(out, "plain", plain);
    plain = "";
  };
  while (i < code.length) {
    const ch = code[i];

    if (ch === "#" && (i === 0 || /\s/.test(code[i - 1]))) {
      const end = code.indexOf("\n", i);
      flush();
      pushToken(out, "comment", code.slice(i, end === -1 ? code.length : end));
      i = end === -1 ? code.length : end;
      continue;
    }

    if (ch === "'" || ch === '"') {
      let end = i + 1;
      while (end < code.length && code[end] !== ch) end += code[end] === "\\" ? 2 : 1;
      const body = code.slice(i + 1, end);
      flush();
      // curl bodies are JSON inside a quoted argument; colour them as JSON.
      if (/^\s*[[{]/.test(body)) {
        pushToken(out, "plain", ch);
        tokenizeJson(body, out);
        pushToken(out, "plain", code.slice(end, end + 1));
      } else {
        pushToken(out, "string", code.slice(i, Math.min(end + 1, code.length)));
      }
      i = end + 1;
      continue;
    }

    if (ch === "$" && /[A-Za-z_{]/.test(code[i + 1] ?? "")) {
      const match = /^\$\{[^}]*\}|^\$[A-Za-z_][\w]*/.exec(code.slice(i));
      if (match) {
        flush();
        pushToken(out, "number", match[0]);
        i += match[0].length;
        continue;
      }
    }

    if (/[A-Za-z]/.test(ch) && atCommandPosition(code, i)) {
      const match = /^[\w./-]+/.exec(code.slice(i));
      if (match) {
        flush();
        pushToken(out, "command", match[0]);
        i += match[0].length;
        continue;
      }
    }

    plain += ch;
    i++;
  }
  flush();
  return out;
}

// --------------------------------------------------------------- typescript

const TS_TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(-?\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g;

function tokenizeTypeScript(code: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  for (const match of code.matchAll(TS_TOKEN)) {
    const start = match.index;
    pushToken(out, "plain", code.slice(last, start));
    const [full, comment, str, num, word] = match;
    if (comment !== undefined) pushToken(out, "comment", comment);
    else if (str !== undefined) pushToken(out, "string", str);
    else if (num !== undefined) pushToken(out, "number", num);
    else if (word !== undefined && TS_KEYWORDS.has(word)) pushToken(out, "literal", word);
    else pushToken(out, "plain", full);
    last = start + full.length;
  }
  pushToken(out, "plain", code.slice(last));
  return out;
}

// ------------------------------------------------------------------- http

function tokenizeHttp(code: string): Token[] {
  const out: Token[] = [];
  for (const [index, line] of code.split("\n").entries()) {
    if (index > 0) pushToken(out, "plain", "\n");
    const request = /^([A-Z]+)( .*)$/.exec(line);
    if (request && HTTP_METHODS.has(request[1])) {
      pushToken(out, "command", request[1]);
      pushToken(out, "plain", request[2]);
      continue;
    }
    const header = /^([\w-]+)(:.*)$/.exec(line);
    if (header) {
      pushToken(out, "property", header[1]);
      pushToken(out, "plain", header[2]);
      continue;
    }
    pushToken(out, "plain", line);
  }
  return out;
}

/**
 * Tokens for one code block. An unknown language, or one this module has no
 * rules for, yields a single plain token.
 */
export function tokenize(code: string, lang: string): Token[] {
  const language = lang.toLowerCase();
  if (!HIGHLIGHTED_LANGUAGES.has(language)) return [{ kind: "plain", value: code }];
  switch (language) {
    case "json":
      return tokenizeJson(code);
    case "ts":
    case "js":
      return tokenizeTypeScript(code);
    case "http":
      return tokenizeHttp(code);
    default:
      return tokenizeShell(code);
  }
}
