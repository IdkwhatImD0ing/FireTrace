# Contributing

Thanks for looking at FireTrace. This file covers the local setup, the commands, the test layers, and what a pull request needs. The product goals and non-goals are summarized in [README.md](README.md); if a change conflicts with "traces never expire" or with "all data access goes through the server", open an issue to discuss it before writing code.

## Setup

Prerequisites:

- Node.js 22 or newer (`.node-version`).
- pnpm 10 (`corepack enable` activates the version pinned in `package.json`; do not use npm or yarn, the lockfile is pnpm's).
- A Java JDK for the Firestore emulator (required by `pnpm emulators` and `pnpm test:integration`; see the [Firebase Local Emulator Suite install docs](https://firebase.google.com/docs/emulator-suite/install_and_configure) for the version).

```bash
pnpm install
pnpm typegen        # generates Next.js route types; rerun after adding routes
cp .env.example .env.local
```

For day-to-day work use the emulator configuration from the README quickstart (`FIRETRACE_USE_EMULATORS=true`, project id `demo-firetrace`, pepper `local-development-pepper-not-for-production-use`). You do not need a Firebase account to develop or test.

## Commands

All scripts live in `package.json`.

| Command                 | Purpose                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | Dev server at <http://localhost:3000>                                                              |
| `pnpm emulators`        | Auth (9099) and Firestore (8080) emulators, UI on 4000, project `demo-firetrace`                   |
| `pnpm seed:emulator`    | Seed owner, project, key, and sample traces (requires `FIRETRACE_USE_EMULATORS=true` in the shell) |
| `pnpm trace:example`    | Send a nested example trace via the SDK (`FIRETRACE_ENDPOINT`, `FIRETRACE_API_KEY`)                |
| `pnpm typecheck`        | `tsc --noEmit` for the app (the SDK has its own: `pnpm sdk:typecheck`)                             |
| `pnpm lint`             | ESLint (`eslint-config-next` core-web-vitals and TypeScript rules)                                 |
| `pnpm format`           | Prettier write; `pnpm format:check` verifies                                                       |
| `pnpm test`             | Unit tests                                                                                         |
| `pnpm test:integration` | Emulator-backed integration tests                                                                  |
| `pnpm test:e2e`         | Playwright browser tests                                                                           |
| `pnpm build`            | Production build                                                                                   |
| `pnpm sdk:build`        | Compile `packages/sdk-js` to `dist/`                                                               |
| `pnpm firebase:deploy`  | Deploy rules, indexes, and Auth config to the project in `.firebaserc`; only for owners            |

## Test layers

Vitest is configured in `vitest.config.mts` with two projects; `@` maps to `src/` and `server-only` is stubbed by `tests/mocks/server-only.ts` so server modules can be imported outside Next.js. The include patterns below are where new tests must go.

| Layer       | Include pattern (from `vitest.config.mts`)                                                                                     | Runs with                                                                                   | Intended coverage                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `tests/unit/**/*.test.ts`, `packages/*/src/**/*.test.ts`                                                                       | `pnpm test` (no network)                                                                    | Schema validation and normalization, canonical hashing, id rules, API-key hashing and timing-safe verification, span tree, storage math, env parsing, SDK behavior |
| Integration | `tests/integration/**/*.test.ts`                                                                                               | `pnpm test:integration` (inside `firebase emulators:exec`, serial files, 30 s test timeout) | Ingestion end to end, idempotency and counters, key revocation, cross-project isolation, deletion of descendants, deny-all rules                                   |
| Browser     | `playwright.config.ts` + `tests/e2e/**/*.spec.ts` (excluded from the root `tsconfig.json`; Playwright type-checks them itself) | `pnpm test:e2e` (`playwright test`)                                                         | Sign-in through the Auth emulator, project and key flows, filters and pagination, trace inspector                                                                  |

Rules for tests:

- Fixtures must contain no real prompts, credentials, or personal data. `src/lib/firetrace/sample.ts` is the shared sample trace.
- Integration tests must only ever target the emulators (`demo-firetrace`). Never point a test at a real Firebase project.
- Do not add a test that depends on wall-clock timing without injecting the SDK `clock` option.

## Pull request expectations

Before opening a PR, run:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm test:integration   # when touching src/lib/firetrace, src/lib/auth, routes, or rules
pnpm build
```

A PR should:

- Solve one problem. Keep refactors separate from behavior changes.
- Keep the security boundary intact: no Firestore access from the browser, no loosening of `firestore.rules`, no `firebase-admin` import outside Node.js server code, every server read or mutation behind `requireOwner()` or `authenticateApiKey`.
- Never introduce an `expireAt` field, a TTL policy, a cleanup job, or any age-based deletion path.
- Keep `src/lib/firetrace/schema.ts` and `packages/sdk-js/src/types.ts` in sync, and update `docs/ingestion-api.md` when a field, limit, or error code changes.
- Not log request bodies, headers, cookies, or key material (see `src/lib/log.ts`).
- Not add dependencies without discussing them in the PR description; the app deliberately depends on little beyond Next.js, Firebase, and Zod.
- Not commit `.env*`, service-account files, or `.firebaserc`.
- Include or update tests for the change and note in the description which commands you ran.

Formatting is Prettier with the settings in `.prettierrc` (100 columns, double quotes, trailing commas). Run `pnpm format` before committing.

## Reporting bugs and proposing features

Open a GitHub issue with reproduction steps against the emulators. For anything security-related, follow [SECURITY.md](SECURITY.md) instead of opening a public issue. Large features that are listed as non-goals in the README (multi-tenant hosting, evaluations, OTLP ingestion, other-language SDKs) are better started as a design discussion than as a PR.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
