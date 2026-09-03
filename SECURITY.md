# Security policy

FireTrace is a self-deployed application maintained by a single person. Please report vulnerabilities privately so a fix can ship before details are public.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. This creates a private security advisory that only the maintainer can see. Do not open a public issue or pull request for security problems.

Include, where you can:

- the affected file or route (for example `src/app/api/v1/traces/route.ts`) and the version or commit,
- steps to reproduce against the Firebase emulators (`pnpm emulators`, `pnpm seed:emulator`) rather than against someone else's deployment,
- the impact you believe it has (data exposure, cross-project access, authentication bypass, denial of service).

You will get an acknowledgement within seven days. Fixes are published on `main` with a note in the advisory; there is no bug bounty.

## Scope

In scope:

- The Next.js application under `src/`, including authentication, session handling, ingestion, and dashboard actions.
- `firestore.rules` and `firestore.indexes.json`.
- The key-authenticated REST API under `/api/v1` and the MCP endpoint at `/api/mcp`, including API-key scopes and expiry.
- The JavaScript SDK in `packages/sdk-js` and the MCP server package in `packages/mcp-server`.
- The scripts under `scripts/` and the documentation's security guidance.

Out of scope:

- Vulnerabilities in Firebase, Google Cloud, Vercel, Next.js, or other dependencies; report those upstream.
- Deployments that ignore the documented configuration (for example, an empty allowlist outside the emulators, a shared API-key pepper, or exposed service-account files).
- Denial of service by exhausting the owner's Firestore quota with a valid API key. This is a documented limitation (`docs/security.md`), not a vulnerability.

## Supported versions

Only the latest commit on `main` receives fixes. There are no long-term support branches.

## Design notes

The threat model, the list of controls with file references, and the known limitations are documented in [docs/security.md](docs/security.md).
