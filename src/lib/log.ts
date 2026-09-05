/**
 * Structured JSON logs. Never pass request bodies, trace content, headers,
 * cookies, or key material; a small denylist strips the obvious mistakes.
 */
const DENIED_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "input",
  "output",
  "metadata",
  "attributes",
  "apikey",
  "api_key",
  "key",
  "secret",
  "token",
  "idtoken",
  "sessioncookie",
  "password",
  "comment",
  "prompt",
  "prompttemplate",
  "reasoning",
]);

type Level = "info" | "warn" | "error";

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (DENIED_KEYS.has(key.toLowerCase())) continue;
    safe[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
