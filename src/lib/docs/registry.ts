/**
 * The documentation pages served at /docs. Each entry points at a Markdown
 * file under docs/ in the repository; the page is rendered from that file at
 * build time, so the site never drifts from the committed docs.
 */
export interface DocEntry {
  slug: string;
  file: string;
  title: string;
  summary: string;
  group: "Get started" | "Reference" | "Operate";
}

export const DOCS: DocEntry[] = [
  {
    slug: "firebase-setup",
    file: "firebase-setup.md",
    title: "Firebase setup",
    summary: "Create the Firebase project, database, sign-in providers, and Admin credential.",
    group: "Get started",
  },
  {
    slug: "vercel-deployment",
    file: "vercel-deployment.md",
    title: "Vercel deployment",
    summary:
      "Import the repository, set environment variables, authorize domains, run the smoke test.",
    group: "Get started",
  },
  {
    slug: "deploy-prompt",
    file: "deploy-prompt.md",
    title: "Deploy with an AI agent",
    summary: "A prompt you paste into a coding agent to have it deploy FireTrace for you.",
    group: "Get started",
  },
  {
    slug: "api",
    file: "api.md",
    title: "API",
    summary: "Scoped keys and every key-authenticated endpoint, with the OpenAPI document.",
    group: "Reference",
  },
  {
    slug: "ingestion-api",
    file: "ingestion-api.md",
    title: "Ingestion API",
    summary:
      "The trace wire format, limits, idempotency rules, and error codes for POST /api/v1/traces.",
    group: "Reference",
  },
  {
    slug: "mcp",
    file: "mcp.md",
    title: "MCP",
    summary:
      "Connect AI agents over the Model Context Protocol: remote endpoint, stdio bridge, tools.",
    group: "Reference",
  },
  {
    slug: "security",
    file: "security.md",
    title: "Security model",
    summary: "Trust boundaries, controls, trial accounts, and the deployment checklist.",
    group: "Operate",
  },
];

export const DOC_GROUPS: DocEntry["group"][] = ["Get started", "Reference", "Operate"];

export function findDoc(slug: string): DocEntry | undefined {
  return DOCS.find((d) => d.slug === slug);
}
