import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function promptBlock(markdown: string): string {
  const match = /```text\n([\s\S]*?)\n```/.exec(markdown);
  if (!match) throw new Error("no ```text block found");
  return match[1];
}

describe("deployment prompt", () => {
  const prompt = promptBlock(read("docs/deploy-prompt.md"));

  it("is embedded verbatim in the README so the two copies cannot drift", () => {
    expect(read("README.md")).toContain(prompt);
  });

  it("names every variable from .env.example that a hosted deployment needs", () => {
    const names = read(".env.example")
      .split("\n")
      .map((line) => /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name))
      .filter((name) => !/EMULATOR/.test(name))
      .filter((name) => name !== "NEXT_PUBLIC_REPOSITORY_URL");
    expect(names.length).toBeGreaterThan(6);
    for (const name of names) expect(prompt, name).toContain(name);
    // The two emulator flags must be mentioned so the agent sets them to false.
    expect(prompt).toContain("FIRETRACE_USE_EMULATORS=false");
    expect(prompt).toContain("NEXT_PUBLIC_FIRETRACE_USE_EMULATORS=false");
  });

  it("uses the repository's own commands and guards", () => {
    for (const needle of [
      "npx -y firebase-tools@latest",
      "pnpm typegen",
      "pnpm trace:example",
      "/api/health",
      "deploy --only firestore",
      "deploy --only auth",
      ".firebaserc.example",
      "Never commit secrets",
      "TTL",
    ]) {
      expect(prompt, needle).toContain(needle);
    }
    // The agent must never be told to install the repo with npm or yarn.
    expect(prompt).not.toMatch(/\bnpm (install|ci)\b(?! -g)/);
    expect(prompt).not.toMatch(/\byarn (install|add)\b/);
  });
});
