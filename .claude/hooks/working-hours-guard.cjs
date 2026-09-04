#!/usr/bin/env node
/**
 * PreToolUse hook: refuse `git commit` and `git push` during working hours so
 * nothing lands on the repository while its owner is at work. Wired up from
 * .claude/settings.local.json (personal, not committed).
 *
 * Environment overrides:
 *   WORKING_HOURS="09:00-17:00"   local-time window, end exclusive
 *   WORKING_DAYS="1-5"            0 = Sunday ... 6 = Saturday; ranges and commas
 *   WORKING_HOURS_NOW=<ISO>       fixed "now" for testing
 */

/** A shell segment that is a git commit or push, allowing leading git options (-c, -C, --no-pager ...). */
const GUARDED_SEGMENT = /^git\s+(?:-{1,2}[\w-]+(?:=\S+)?(?:\s+(?!commit\b|push\b)[^\s-]\S*)?\s+)*(commit|push)\b/;

function guardedCommand(command) {
  return command
    .split(/\n|&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .some((segment) => GUARDED_SEGMENT.test(segment));
}

function parseDays(spec) {
  const days = new Set();
  for (const part of spec.split(",")) {
    const range = part.trim().match(/^(\d)(?:-(\d))?$/);
    if (!range) continue;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    for (let d = from; d <= to; d++) days.add(d);
  }
  return days;
}

function parseWindow(spec) {
  const m = spec.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return [9 * 60, 17 * 60];
  return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
}

function pad(n) {
  return String(n).padStart(2, "0");
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let command = "";
  try {
    command = String(JSON.parse(input).tool_input?.command ?? "");
  } catch {
    return;
  }
  if (!guardedCommand(command)) return;

  const now = process.env.WORKING_HOURS_NOW ? new Date(process.env.WORKING_HOURS_NOW) : new Date();
  const [start, end] = parseWindow(process.env.WORKING_HOURS || "09:00-17:00");
  const days = parseDays(process.env.WORKING_DAYS || "1-5");
  const minutes = now.getHours() * 60 + now.getMinutes();
  const working = days.has(now.getDay()) && minutes >= start && minutes < end;
  if (!working) return;

  const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Working-hours guard: commits and pushes are only allowed outside ` +
          `${fmt(start)}-${fmt(end)} local time on working days. It is ${pad(now.getHours())}:${pad(now.getMinutes())} now; ` +
          `leave the work uncommitted and try again after ${fmt(end)}.`,
      },
    }),
  );
});
