# Security model

This document describes what FireTrace protects, who it protects against, and how each safeguard is implemented. File references are to this repository. For reporting a vulnerability see [SECURITY.md](../SECURITY.md).

## Deployment shape

A FireTrace deployment is a Next.js application (typically on Vercel) plus one Firebase project owned by the operator. There is no hosted FireTrace service and no shared infrastructure between deployments. The operator is both the administrator and, in most cases, the only user.

## Assets

| Asset                          | Where it lives                                                  | Exposure if compromised                                                  |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Firebase Admin service account | `FIREBASE_SERVICE_ACCOUNT_BASE64` (server env only)             | Full read/write of the Firestore database and Firebase Auth              |
| API-key pepper                 | `FIRETRACE_KEY_PEPPER` (server env only)                        | Offline verification of stolen key digests; rotating it invalidates keys |
| Project API keys               | Shown once; only HMAC digests in `apiKeys/{keyId}`              | Ability to write traces into one project until the key is revoked        |
| Owner session cookie           | `firetrace_session`, HTTP-only, set by `POST /api/auth/session` | Full dashboard access for up to five days                                |
| Trace content                  | `projects/{projectId}/traces/**` in the owner's Firestore       | Prompts, outputs, metadata, and identifiers you chose to send            |

## Actors and trust boundaries

- **Anonymous internet clients** can reach `/`, `/login`, `/api/health` (booleans only), `/api/auth/session`, and `POST /api/v1/traces`. They cannot read any data.
- **Holder of a valid API key** can do what the key's scopes allow, in exactly one project and never another: record traces and merge into their `metadata` (`traces:write`), read and list them (`traces:read`), delete them (`traces:delete`). The project comes from the key document, never from the request (`src/lib/firetrace/ingest.ts`, `metadata.ts`, `api-auth.ts`).
- **Allowlisted owners** (every address in `DASHBOARD_ALLOWED_EMAILS`) have full access to every project, key, and trace. FireTrace has no roles or per-project permissions; treat the allowlist as a list of co-administrators.
- **The Firebase project and Vercel account** are trusted. Anyone with console or IAM access to either can read or delete everything; protect those accounts with strong authentication.
- **The browser** is untrusted with respect to data access. The Firebase Web SDK is used only to obtain an ID token; `firestore.rules` denies all direct reads and writes, so a compromised or modified client can do nothing that the server does not independently authorize.

## Controls

### Server-only data access

- All Firestore and Firebase Auth calls go through the Admin SDK in `src/lib/firebase/admin.ts`, which imports `server-only` and is initialized once per process from the base64 credential decoded in memory. Nothing is written to disk.
- Route handlers that touch Firebase declare `export const runtime = "nodejs"`, and `next.config.ts` lists `firebase-admin` in `serverExternalPackages` so it is never bundled for the browser or an Edge runtime.
- Browser configuration is limited to the `NEXT_PUBLIC_*` values enumerated in `src/lib/env/client.ts`. `src/lib/env/server.ts` holds everything else and is itself `server-only`.

### Firestore rules deny everything

`firestore.rules` contains a single `allow read, write: if false` match for every document. The Admin SDK bypasses rules, so authorization is enforced in application code (below), and the rules exist to guarantee that no client path exists at all.

### Dashboard authentication

- `POST /api/auth/session` (`src/app/api/auth/session/route.ts`) verifies the Firebase ID token with `verifyIdToken(token, true)` (revocation-checked), requires the email to be verified and allowlisted (`isAllowedIdentity` in `src/lib/auth/session.ts`), then mints a Firebase session cookie with a five-day lifetime. The cookie is HTTP-only, `SameSite=Lax`, `Secure` in production or on any `https://` app URL, and scoped to `/`.
- Every server read re-verifies the cookie with `verifySessionCookie(value, true)` and re-checks the allowlist (`getOwner`, `requireOwner`). The dashboard layout (`src/app/(dashboard)/layout.tsx`), server actions (`src/lib/actions.ts`), and the export route all go through these helpers. A cookie's presence proves nothing by itself.
- Logout (`DELETE /api/auth/session`) clears the cookie. It does not revoke Firebase refresh tokens; to invalidate all sessions for a user immediately, revoke their refresh tokens in Firebase (Admin SDK `revokeRefreshTokens`), which the revocation-checked verification then honors.
- Production fails closed: `buildServerEnv` refuses to start when `DASHBOARD_ALLOWED_EMAILS` is empty, when the service account is missing, when the pepper is shorter than 32 characters, or when `FIRETRACE_USE_EMULATORS=true`. The emulator allowlist bypass applies only outside production with the emulator flag set and an empty allowlist.
- Email/password sign-up is enabled in `firebase.json` and on the login form. Anyone can create a Firebase account, but the server rejects any identity that is not both verified and allowlisted, so account creation grants nothing.

### Trial accounts (optional)

- Off by default. With `FIRETRACE_TRIAL_TRACE_LIMIT > 0`, `isAllowedIdentity` (`src/lib/auth/session.ts`) admits any _verified_ email that is not on the allowlist with `role: "trial"`; allowlisted emails keep `role: "owner"`. The role is re-derived from the environment on every request, so turning the variable off locks trial sessions out immediately.
- Visibility: every dashboard page, server action, and the export route resolve projects through `getAccessibleProject` / `requireAccessibleProject` (`src/lib/auth/access.ts`). Trial users can open only projects whose `ownerUid` is theirs; anything else is a 404, indistinguishable from a missing id. Owners see everything.
- Identity: trial accounting is keyed on the verified email (`trialSubject`, a SHA-256 of the lowercased address), not the Firebase uid, because a user can delete and recreate their Firebase account for free but not their email. A recreated account keeps its history and its cap.
- Caps: `createProject` refuses a second trial project for the same email inside its transaction, and checks that cap before the name check so a capped account cannot probe names; trial name/slug uniqueness is scoped to the account's own projects. `ingestTrace` reads `trialUsage/{subject}` inside the ingestion transaction, rejects with `403 trial_limit_reached` at the limit, and increments the counter only when a trace is actually stored (duplicates do not count). The counter never decreases, so deleting traces or the project cannot refill it. Trial projects hold at most `TRIAL_MAX_KEYS` API keys, revoked ones included. The REST route and the MCP `record_trace` tool share this path.
- Status changes: whether a project is capped is decided per request by `effectivePlan` (its stored plan plus whether its creator is on the allowlist right now). Adding a trial user to `DASHBOARD_ALLOWED_EMAILS` lifts the cap on their project; removing a co-owner from the allowlist while trial mode is on turns them into a trial user who can no longer see or use the projects they created as an owner. Switching trial mode off rejects trial sessions and, through `requireTrialModeForKey`, every API key issued for a trial project. API keys are not tied to sessions, so when you demote a co-owner also revoke the keys they hold in the project settings.
- Exposure: trial users can read only their own data, but their traces live in the owner's Firestore and count against its quota (at most `limit × 2 MiB` per account). Keep the limit small and treat the instance as public when the variable is set.

### Origin checks on cookie-authenticated mutations

`assertSameOrigin` (`src/lib/auth/origin.ts`) requires an `Origin` header equal to either the canonical `NEXT_PUBLIC_APP_URL` origin or the request's own forwarded host. It runs on session creation and logout. Dashboard mutations are Next.js server actions, which Next.js itself rejects when the `Origin` does not match the `Host`; each action then calls `requireOwner()` before doing anything.

### API keys

- Format `ft_live_<keyId>_<secret>` with a 16-hex-character id and 64 hex characters of secret from `crypto.randomBytes(32)` (`src/lib/firetrace/api-keys.ts`).
- Storage: `HMAC-SHA-256(FIRETRACE_KEY_PEPPER, plaintext)` only, with the last four characters kept for display. Verification uses `crypto.timingSafeEqual`.
- The plaintext is returned exactly once from `createApiKey` / `rotateApiKey` (`src/lib/firetrace/projects.ts`) and rendered once in the settings panel; it is not persisted anywhere and cannot be retrieved after navigation.
- Revocation sets `revokedAt`; `authenticateApiKey` rejects revoked keys on the next request. Rotation revokes the old key and creates the new one in a single transaction.
- All authentication failures (missing, malformed, unknown, revoked, expired) return an identical `401 invalid_api_key` with a `WWW-Authenticate: Bearer` challenge, so responses do not reveal whether a key id exists.
- **Scopes** (`src/lib/firetrace/scopes.ts`): each key stores `scopes` chosen at creation from `traces:write`, `traces:read`, `traces:delete`. `withApiKey(scope, …)` (`api-handler.ts`) calls `requireScope` before the handler runs and answers `403 insufficient_scope`. Keys created before scopes existed are treated as `traces:write` only. Rotation copies scopes and expiry.
- **Expiry**: optional `expiresAt` (30 d / 90 d / 1 y presets); `keyIsUsable` rejects a key at or past the instant. `lastUsedAt` is refreshed at most every five minutes and never carries request content.
- **MCP** (`src/app/api/mcp/route.ts`): the same bearer authentication runs before any JSON-RPC message is parsed; the server is built per request (stateless, no session ids, `GET`/`DELETE` are 405) and only registers tools the key's scopes allow. Deletion additionally requires `confirm: true`.

### Logging

`src/lib/log.ts` emits single-line JSON and drops any field named `authorization`, `cookie`, `set-cookie`, `input`, `output`, `metadata`, `attributes`, `apikey`, `api_key`, `key`, `secret`, `token`, `idtoken`, `sessioncookie`, or `password`. Ingestion logs contain request id, project id, key id, trace id, counts, timing, and error codes. Session logs contain request id and uid. Unexpected errors are logged as name and message only; responses in production carry a generic message plus the request id (`errorToResponse` in `src/lib/firetrace/errors.ts`).

### Stored content is rendered as text

`src/components/ui/JsonView.tsx` renders JSON through React text nodes with regex-based token highlighting; there is no `dangerouslySetInnerHTML` anywhere under `src/`. Stored strings cannot inject markup or scripts into the dashboard.

### Ingestion limits

- Schema: strict Zod objects (`src/lib/firetrace/schema.ts`) reject unknown keys at every level; ids, enums, timestamps, and string lengths are validated; token counts and costs must be non-negative.
- Counts: at most 200 spans, 50 events per span, and 20 tags; names up to 500 characters; identifiers up to 200.
- Bytes: request bodies over 2 MiB are rejected from the `Content-Length` header before authentication and again after reading; each normalized trace or span document over 750 KiB is rejected (`src/lib/firetrace/normalize.ts`, `src/app/api/v1/traces/route.ts`).
- Structure: duplicate span ids, unknown or self parents, and parent cycles are rejected (`src/lib/firetrace/tree.ts`).
- There is no explicit JSON nesting-depth limit; depth is bounded by the byte limits. There is no application-level rate limiter; `429` is returned only when Firestore reports an exhausted quota.

### Deletion is scoped to a validated project path

`deleteTraceAction` and `deleteProjectAction` (`src/lib/actions.ts`) require an owner session, validate the project id against `^[0-9a-f]{24}$` and the trace id against `^[0-9a-f]{32}$`, and require the typed project name for project deletion. `deleteTrace` and `deleteProject` (`src/lib/firetrace/projects.ts`) operate only under `projects/{projectId}/...` and on `apiKeys` documents whose `projectId` matches. There is no age-based or scheduled deletion path.

### Idempotency and immutability

Traces are immutable apart from `metadata`. A retry with identical content is a no-op, and a different body under an existing trace id is rejected with `409` inside the same transaction that would otherwise write it (`ingestTrace`). Counters are updated in that transaction, so a partial write cannot leave the project statistics inconsistent.

`PATCH /api/v1/traces/{traceId}` (`src/lib/firetrace/metadata.ts`) is the single exception, and a narrow one: a strict body admits `metadata` and nothing else, the merge runs in a transaction that first confirms the trace exists under the key's own project, and the write touches `metadata`, `metadataUpdatedAt`, and `estimatedBytes` only — never a span, an identifier, a timing, or `bodyHash`. It is last-writer-wins with no history, so metadata is not a place for anything that needs an audit trail.

### Evaluators (optional)

LLM-as-a-judge evaluators ([evaluators.md](./evaluators.md)) are enabled only when `FIRETRACE_EVAL_BASE_URL`, `FIRETRACE_EVAL_API_KEY` and `FIRETRACE_EVAL_MODEL` are all set. The key is server-only and is sent as a bearer token to that one endpoint. Only allowlisted owners can define or run evaluators (`src/lib/actions.ts` rejects trial sessions with `403`), because a run spends the key and sends the trace's input, output, metadata and span names to the endpoint. FireTrace logs the model, status, timing and token counts of each call, never the prompt or the completion; the judge's answer is stored only as a score value and comment.

## Checklist

The handoff checklist, with the implementing file or the owner action for each item.

| Item                                                                                   | Status                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin credentials exist only in server-side environment variables                      | Implemented: `src/lib/env/server.ts`, `src/lib/firebase/admin.ts`, `next.config.ts`. Owner action: keep the value only in `.env.local` and Vercel Sensitive variables.             |
| Firestore rules deny all direct browser access                                         | Implemented: `firestore.rules`. Owner action: deploy them (`docs/firebase-setup.md`, step 7).                                                                                      |
| Dashboard ID tokens and session cookies are verified with Firebase Admin               | Implemented: `src/lib/auth/session.ts`, `src/app/api/auth/session/route.ts`.                                                                                                       |
| Production requires a nonempty email allowlist                                         | Implemented: `buildServerEnv` in `src/lib/env/server.ts`.                                                                                                                          |
| Project API keys are random, hashed, revocable, and shown once                         | Implemented: `src/lib/firetrace/api-keys.ts`, `src/lib/firetrace/projects.ts`, `src/components/settings/ApiKeysPanel.tsx`.                                                         |
| Authorization headers, cookies, prompts, responses, and secrets are excluded from logs | Implemented: `src/lib/log.ts` denylist; route handlers log ids and counts only.                                                                                                    |
| Cookie-authenticated mutations validate request origin                                 | Implemented: `src/lib/auth/origin.ts` for the session route; Next.js server-action origin check plus `requireOwner()` in `src/lib/actions.ts`.                                     |
| Stored JSON is rendered as text, never trusted HTML                                    | Implemented: `src/components/ui/JsonView.tsx`; no `dangerouslySetInnerHTML` in `src/`.                                                                                             |
| Ingestion has strict schema, count, depth, and byte limits                             | Implemented for schema, counts, and bytes (`schema.ts`, `normalize.ts`, the route). Depth is bounded indirectly by the byte limits; there is no separate depth cap.                |
| Deletion operates only inside a validated project path                                 | Implemented: `src/lib/actions.ts`, `src/lib/firetrace/projects.ts`.                                                                                                                |
| Dependency updates and secret scanning are enabled in GitHub                           | Owner action. CI lives in `.github/workflows/ci.yml`, but Dependabot (or Renovate) and secret scanning with push protection are repository settings: enable them after publishing. |
| `SECURITY.md` explains private vulnerability reporting                                 | Done: [SECURITY.md](../SECURITY.md).                                                                                                                                               |
| README warns users not to capture credentials or regulated personal data               | Done: README section "Data and privacy model".                                                                                                                                     |

## Known limitations

- Any allowlisted email is a full co-owner. Do not allowlist people who should not see every project.
- A leaked API key allows writes into its project until revoked. Rotate keys from the settings page if you suspect exposure; the old key stops working on the next request.
- Session cookies remain valid until expiry (five days) after logout unless the user's refresh tokens are revoked in Firebase.
- Firestore quotas are the only ingestion throttle. A hostile client with a valid key can consume your daily write quota; there is no per-key rate limit.
- Firebase and Vercel operational security (IAM, 2FA, audit logs, backups) is the owner's responsibility and outside this codebase.
