# CLAUDE.md

Guidance for Claude Code in this repo. Keep it short — every line here competes for attention with the actual task. If a line wouldn't change Claude's behavior, delete it.

## Working principles

**Think before coding.** State assumptions out loud. If a request is ambiguous, ask or present the interpretations — don't silently pick one. Suggest a simpler approach when you see one, and push back when warranted.

**Simplicity first.** Write the minimum code that solves the stated problem. No speculative features, no unrequested flexibility, no error handling for impossible cases. If it's bloated, rewrite it smaller. Test: would a senior engineer call this overcomplicated?

**Surgical changes.** Edit only what the request requires. Preserve existing style and formatting. Don't refactor working code. Only remove imports/variables/functions that *your* change orphaned. Flag pre-existing dead code — don't delete it. Core test: every changed line traces directly to the request.

**Goal-driven execution.** Define verifiable success criteria before starting. Turn vague tasks into testable outcomes. For multi-step work, outline the plan with verification checkpoints. "Make it work" is not a success criterion.

## Honesty rules (read every turn)

- Before claiming a function, class, type, or import exists, verify it — read the file or grep for it. Never fabricate symbols.
- If you can't verify something, say "I haven't verified this" explicitly, and don't write code that depends on the unverified claim.
- Don't add a library that isn't already referenced in this project without asking first.
- Don't claim a test or build passed unless you actually ran the command this session.
- Never invent error messages, API responses, or stack traces. If you didn't see it, say so.
- When you genuinely don't know, "I don't know" or "I need to check first" is the correct answer — always better than a confident guess.

## Verification protocol

Before writing or editing code that uses a symbol, do one of:
1. Read the file where it's defined and confirm the signature.
2. `grep -r "symbolName" .` (or Glob) to find it.
3. Check `package.json` for the dependency.

If you skip verification, prefix the code with `// UNVERIFIED: I have not confirmed this symbol exists`.

Enforcement lives outside this file: `.claude/settings.json` type-checks after every write and on stop (Layer 3), and `.claude/agents/fact-checker.md` verifies claims before commits (Layer 4). See `CLAUDE-CODE-GUIDELINES.md` for the why.

Prefer plan-then-execute for any task touching more than one file.

## Firebase

Always look for and use the appropriate **Firebase agent skills** to perform tasks related to Firebase.

- This repo's own deployment uses project `firetrace-d74df`, web app "FireTrace Web" (Google sign-in + email/password enabled; Firestore `(default)`, Standard edition, `nam5`). Forks bring their own project; never hard-code this id in app code or docs.
- Use `npx -y firebase-tools@latest …`, never bare `firebase`. CLI config: `firebase.json` (auth providers, firestore, emulators); `.firebaserc` is gitignored, see `.firebaserc.example`. Rules: `firestore.rules`. Indexes: `firestore.indexes.json`.
- `firestore.rules` is deny-all on purpose and must stay that way: no client ever reads or writes Firestore directly. The security boundary is server code (`requireOwner()` / `authenticateApiKey()`), not rules. Deploy rules and indexes with `pnpm firebase:deploy`; add a composite index only for a query the UI actually runs.
- Web SDK (`src/lib/firebase/client.ts`) is for sign-in only. Admin SDK (`src/lib/firebase/admin.ts`, `server-only`) bypasses rules, so every server read/mutation authorizes first and validates input with the Zod schema in `src/lib/firetrace/schema.ts`.

## Project context

- **What this is:** FireTrace, a self-deployed LLM tracing app: Next.js dashboard on Vercel + one owner-controlled Firebase project (Firestore + Auth). Applications `POST /api/v1/traces` with a per-project key; the dashboard lists traces and renders a span tree, waterfall and inspector. Defining feature: **infinite retention** — no TTL, no `expireAt`, no cleanup job, no age-based deletion; only explicit owner actions delete. Capacity is bounded by the owner's Firebase storage quota (see README).
- **Stack:** Next.js 16 App Router under `src/`, React 19, TypeScript, Tailwind 4, Zod 4, `firebase-admin` on the server, `firebase` Web SDK for sign-in only (`src/lib/firebase/client.ts`). Package manager is pnpm (`packages/sdk-js` is a workspace package, `@firetrace/sdk`).
- **Data access is Admin-SDK-only.** `firestore.rules` denies every direct client read/write. All reads and mutations run in server code (`src/lib/firebase/admin.ts`, Node runtime) and must first call `requireOwner()`/`getOwner()` (`src/lib/auth/session.ts`) or `withApiKey(scope, handler)` (`src/lib/firetrace/api-handler.ts`, which wraps `authenticateApiKey()` + `requireScope()` from `api-auth.ts`). Route handlers that import firebase-admin declare `export const runtime = "nodejs"`.
- **Dashboard auth:** login page signs in with Firebase (Google popup or verified email/password), posts the ID token to `POST /api/auth/session`, server verifies it, checks `DASHBOARD_ALLOWED_EMAILS`, sets the `firetrace_session` cookie (HTTP-only, SameSite=Lax, Secure in prod, 5 days). Every allowlisted email is a co-owner (`role: "owner"`). Optional trial mode (`FIRETRACE_TRIAL_TRACE_LIMIT > 0`, `src/lib/firetrace/trial.ts`) admits other verified emails as `role: "trial"`: one project, N traces ever (counter `trialUsage/{sha256(email)}` incremented inside the ingest transaction, never decremented; `effectivePlan()` decides per request whether a project is capped), then `403 trial_limit_reached`. Dashboard code resolves projects through `getAccessibleProject()`/`requireAccessibleProject()` (`src/lib/auth/access.ts`) so trial users only see their own. `src/lib/auth/origin.ts` checks `Origin` on cookie-authenticated routes; dashboard mutations are server actions in `src/lib/actions.ts`.
- **Config:** `src/lib/env/server.ts` (server-only, fails closed in production: allowlist, service account, 32+ char pepper required; emulator flag forbidden) and `src/lib/env/client.ts` (`NEXT_PUBLIC_*` only). Template: `.env.example`.
- **Data model:** `projects/{projectId}` (24 hex), top-level `apiKeys/{keyId}` (HMAC digest only; plaintext `ft_live_<16hex>_<64hex>` shown once; `scopes` from `scopes.ts` — `traces:write|read|delete`, legacy docs without `scopes` = write-only; optional `expiresAt`; throttled `lastUsedAt`), `projects/{id}/traces/{traceId}` (32 hex, immutable, `bodyHash` for idempotency), `.../spans/{spanId}` (16 hex). Indexes in `firestore.indexes.json`; large payload fields are exempted.
- **Ingestion pipeline:** `src/lib/firetrace/schema.ts` (Zod wire schema + `LIMITS`) → `normalize.ts` (semantic checks, byte estimate, canonical hash via `hash.ts`, tree via `tree.ts`) → `ingest.ts` (transaction: 201 created / 200 duplicate / 409 conflict / 429 quota). Errors use the envelope in `errors.ts`. Keep `schema.ts` and `packages/sdk-js/src/types.ts` in sync and update `docs/ingestion-api.md` when limits or codes change.
- **Key-authenticated API** (`docs/api.md`, OpenAPI from `openapi.ts` at `/api/v1/openapi.json`): `POST/GET /api/v1/traces`, `GET/DELETE /api/v1/traces/[traceId]`, `GET /api/v1/project`, `GET /api/v1/key`. **MCP** (`docs/mcp.md`): `packages/mcp-server` (`@firetrace/mcp`, workspace package transpiled by Next) exports `createFireTraceMcpServer(backend)` + `TraceBackend`; the app serves it statelessly at `POST /api/mcp` over `src/lib/mcp/firestore-backend.ts`; the stdio bridge uses `HttpBackend` against the REST API. Tools are registered per scope. Integration tests call the handlers directly via `tests/integration/api-helpers.ts`.
- **Docs site:** `/docs` and `/docs/[slug]` (`src/app/docs`, public, rendered per request so the header can show the visitor's session) render `docs/*.md` through `src/lib/docs` (registry → `parseMarkdown` → React; no Markdown dependency, no raw HTML). Add a new doc to `DOCS` in `registry.ts`; relative `.md` links are rewritten to `/docs` routes.
- **Other modules:** `projects.ts` (project/key CRUD, cascading deletes), `queries.ts` (cursor-paginated trace list, filters `status|model|sessionId|userId|from|to`, page params `after|before`), `storage.ts` (estimate + 70%/90% warnings), `sample.ts` (deterministic sample trace), `src/lib/log.ts` (JSON logs with a secret/content denylist).
- **Next.js 16 conventions:** read `AGENTS.md` and `node_modules/next/dist/docs/`. `params`/`searchParams` are Promises; `PageProps`/`RouteContext` types are generated by `pnpm typegen`.
- **Docs to keep accurate:** `README.md`, `docs/*.md`, `packages/sdk-js/README.md`, `CONTRIBUTING.md`, `SECURITY.md`.

## Commands

- `pnpm install`, then `pnpm typegen` once after cloning or adding routes (otherwise `tsc` fails on generated types).
- `pnpm dev` — http://localhost:3000. Needs `.env.local` (copy `.env.example`; for local work set `FIRETRACE_USE_EMULATORS=true`, `NEXT_PUBLIC_FIRETRACE_USE_EMULATORS=true`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-firetrace`).
- `pnpm emulators` — Auth 9099 + Firestore 8080 for project `demo-firetrace` (needs Java). `FIRETRACE_USE_EMULATORS=true pnpm seed:emulator` seeds an owner, a project, a key and sample traces. `FIRETRACE_ENDPOINT=... FIRETRACE_API_KEY=... pnpm trace:example` sends a nested trace via the SDK.
- `pnpm typecheck && pnpm lint && pnpm build` — all three must pass before claiming work is done. `pnpm format` / `pnpm format:check` for Prettier.
- `pnpm test` — vitest `unit` project (`tests/unit`, `packages/*/src`). `pnpm test:integration` — vitest `integration` project inside `firebase emulators:exec`. `pnpm test:e2e` — Playwright.
- `pnpm sdk:typecheck` / `pnpm sdk:build` — the SDK has its own tsconfig; the root tsconfig excludes `packages`. `pnpm mcp:typecheck` / `pnpm mcp:build` / `pnpm mcp:stdio` for `packages/mcp-server`.
- `pnpm firebase:deploy` — deploys rules, indexes and the Auth provider config to the project in `.firebaserc`. Only when explicitly asked.

## Guardrails

- Never commit `.env*`, service-account JSON, `.firebaserc`, or `firebase-debug.log`. Never read or print values from `.env.local`.
- Never point tests or scripts at the real Firebase project. Emulator project id is `demo-firetrace`; `scripts/seed-emulator.ts` refuses to run without `FIRETRACE_USE_EMULATORS=true`.
- Never add `expireAt`, a TTL policy, a scheduled cleanup, or any age-based deletion. Deletion happens only in `deleteTrace`/`deleteProject` behind an owner session.
- Don't loosen `firestore.rules` (deny all). Don't import `firebase-admin` in client components, middleware/proxy, or Edge code. Don't bypass `requireOwner()`/`withApiKey()`; every new key-authenticated route names the scope it needs, and dashboard code that touches a project goes through `requireAccessibleProject()`/`getAccessibleProject()` rather than `getProject()` directly.
- Never log Authorization headers, cookies, plaintext keys, or trace input/output; go through `src/lib/log.ts`.
- Don't add a dependency or change `package.json`/`pnpm-lock.yaml` without asking; use pnpm, never npm/yarn. Don't commit or push unless asked.
