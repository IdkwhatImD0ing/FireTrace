# Vercel deployment

FireTrace runs as a standard Next.js application on Vercel. This guide assumes you have completed [firebase-setup.md](firebase-setup.md) and pushed your fork to a Git provider that Vercel can import from.

## 1. Import the repository

1. In the Vercel dashboard choose **Add New > Project** and import your fork.
2. Leave **Root Directory** at the repository root; the Next.js app lives there.
3. **Framework Preset** is detected as Next.js. Keep the default build command (`next build`) and output settings. Vercel installs with pnpm because `package.json` pins `"packageManager": "pnpm@10.26.1"` and `pnpm-lock.yaml` is committed.
4. Under **Settings > General > Node.js Version** select a version that satisfies `"engines": { "node": ">=22" }`.
5. Add the environment variables from the next section before the first deployment, or trigger a redeploy after adding them.

## 2. Environment variables

Add each variable under **Settings > Environment Variables** and tick the environments it applies to. Every variable in `.env.example` is listed below.

| Variable                                                 | Production                     | Preview                              | Notes                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_FIREBASE_API_KEY`                           | from `apps:sdkconfig`          | same, or a separate Firebase project | Inlined at build time; changing it requires a redeploy.                                                                                                  |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`                       | `<PROJECT_ID>.firebaseapp.com` | same                                 |                                                                                                                                                          |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID`                        | `<PROJECT_ID>`                 | same                                 | Also read by the server to initialize the Admin SDK.                                                                                                     |
| `NEXT_PUBLIC_FIREBASE_APP_ID`                            | from `apps:sdkconfig`          | same                                 |                                                                                                                                                          |
| `FIREBASE_SERVICE_ACCOUNT_BASE64`                        | required                       | required                             | Mark as **Sensitive**. Production fails closed without it.                                                                                               |
| `DASHBOARD_ALLOWED_EMAILS`                               | required                       | required                             | Comma-separated. All listed emails are co-owners.                                                                                                        |
| `FIRETRACE_KEY_PEPPER`                                   | required                       | required                             | Mark as **Sensitive**. Use the same value in every environment that shares a Firestore database, or keys created in one will not work in the other.      |
| `NEXT_PUBLIC_APP_URL`                                    | `https://<your-domain>`        | `https://<your-domain>` (see note)   | No trailing slash. Must be an absolute URL.                                                                                                              |
| `FIRETRACE_STORAGE_LIMIT_BYTES`                          | optional                       | optional                             | Storage-warning allowance in bytes; default 1 GiB.                                                                                                       |
| `FIRETRACE_TRIAL_TRACE_LIMIT`                            | optional                       | optional                             | Trial mode: lets accounts outside the allowlist sign in with one project and this many traces, ever. Unset/0 keeps the deployment private (README).      |
| `FIRETRACE_EVAL_BASE_URL`                                | optional                       | optional                             | LLM-as-a-judge evaluators: an OpenAI-compatible base URL such as `https://api.openai.com/v1`. Set together with the two below, or leave all three unset. |
| `FIRETRACE_EVAL_API_KEY`                                 | optional                       | optional                             | Bearer key for that endpoint. Server-only; never sent to the browser.                                                                                    |
| `FIRETRACE_EVAL_MODEL`                                   | optional                       | optional                             | Default judge model, e.g. `gpt-5-mini`; an evaluator can override it.                                                                                    |
| `FIRETRACE_USE_EMULATORS`                                | do not set                     | do not set                           | `true` makes production refuse to start (`src/lib/env/server.ts`).                                                                                       |
| `NEXT_PUBLIC_FIRETRACE_USE_EMULATORS`                    | do not set                     | do not set                           | Would point the browser at `127.0.0.1:9099`.                                                                                                             |
| `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST` | do not set                     | do not set                           | Emulator addresses; only meaningful with the flag above.                                                                                                 |

Notes:

- **Preview environments share Firestore with production unless you give them their own Firebase project.** Previews use whatever `NEXT_PUBLIC_FIREBASE_PROJECT_ID` and service account you assign to the Preview environment. For isolation, repeat `docs/firebase-setup.md` for a second Firebase project and assign its values to Preview only.
- `NEXT_PUBLIC_APP_URL` on previews: cookie-authenticated requests are accepted from both the configured URL and the request's own host (`src/lib/auth/origin.ts` reads `x-forwarded-host`), so previews work even though their hostname is generated. The value only affects the URLs shown in the project's setup panel.
- Vercel sets `NODE_ENV=production` for both Production and Preview deployments, so both run in fail-closed mode: the allowlist, the service account, and a 32+ character pepper are all required, and the session cookie is marked `Secure`.
- Server-side variables are read at runtime; after changing one, redeploy so running functions pick it up. `NEXT_PUBLIC_*` variables are inlined into the client bundle at build time and always require a redeploy.

## 3. Deploy and verify

Deploy from the Vercel dashboard or by pushing to the production branch. Then:

1. Open `https://<deployment>/api/health`. Expected: `{"ok":true,"firebaseConfigured":true,"authConfigured":true,"ingestConfigured":true,"emulators":false}`. In production the `problems` list is omitted; if `ok` is `false`, compare the variables against the table above (`firebaseConfigured` covers the project id and service account, `authConfigured` the allowlist, `ingestConfigured` the pepper).
2. Open `https://<deployment>/login`. If the page shows "This deployment is not fully configured", a `NEXT_PUBLIC_*` value is missing from the build or a server value is missing.

## 4. Custom domains and Firebase authorized domains

1. Add the domain under **Settings > Domains** in Vercel and complete DNS verification.
2. Add the same hostname to Firebase's authorized domains (**Authentication > Settings > Authorized domains** in the console, or the Identity Toolkit API call in [firebase-setup.md](firebase-setup.md#5-authorized-domains); the Firebase CLI cannot do it). Sign-in on a hostname that is not authorized fails in the popup with `auth/unauthorized-domain`.
3. Set `NEXT_PUBLIC_APP_URL` to `https://<your-domain>` and redeploy.

The default `<project>.vercel.app` hostname also needs to be authorized if you sign in there.

## 5. First sign-in

1. Open `/login` and choose **Continue with Google**, using an account whose email is in `DASHBOARD_ALLOWED_EMAILS`.
2. The browser sends the Firebase ID token to `POST /api/auth/session`; the server verifies it with the Admin SDK, checks the allowlist, and sets the `firetrace_session` cookie (HTTP-only, `Secure`, `SameSite=Lax`, five days).
3. You land on `/projects`. Create a project, open **Settings**, and create an API key. Copy it immediately; only its HMAC digest is stored and the plaintext is never shown again.

Troubleshooting:

- "`<email>` is not in the dashboard allowlist": add the email to `DASHBOARD_ALLOWED_EMAILS` and redeploy.
- "Verify the email address on this account": email/password accounts must click the verification link first; Google accounts are verified automatically.
- "Cross-origin request rejected" on sign-in: the request `Origin` matched neither `NEXT_PUBLIC_APP_URL` nor the forwarded host. Check for a trailing slash or a `http://` vs `https://` mismatch in `NEXT_PUBLIC_APP_URL`.

## 6. Smoke test with the example trace

From your local clone, send the example trace to the deployment using the key you just created:

```bash
FIRETRACE_ENDPOINT=https://<your-domain> FIRETRACE_API_KEY=ft_live_... pnpm trace:example
```

The script (`scripts/send-example-trace.ts`) uses the SDK to send one trace with an agent root span, a tool span, and an LLM span, then prints `Stored trace <id> (3 spans) in project <projectId>` and the URL of the trace page. Open it and confirm the tree, the waterfall, and the inspector tabs render. Run the command a second time: the response is a duplicate (`200`, `"duplicate": true`) and the project's trace count does not change.

Without Node.js, use the curl example from `docs/ingestion-api.md`.

## Operational notes

- Ingestion and dashboard routes declare `export const runtime = "nodejs"`; `firebase-admin` is kept external to the bundle by `next.config.ts` (`serverExternalPackages`). Do not move these routes to the Edge runtime.
- Every Firestore write is awaited before the function responds. There are no background jobs, cron entries, or TTL policies to configure.
- Requests larger than 2 MiB are rejected with `413` by FireTrace, below Vercel's own request-body limit.
- Logs are single-line JSON with a `requestId` field (`src/lib/log.ts`). They contain ids, counts, and error codes only; never trace content, headers, cookies, or keys.
- To rotate the Admin credential, generate a new key in Firebase, update `FIREBASE_SERVICE_ACCOUNT_BASE64`, redeploy, then delete the old key in Google Cloud IAM.
- To move to a new Vercel project or domain, keep `FIRETRACE_KEY_PEPPER` and the Firebase project unchanged and existing API keys keep working.

References: [Vercel environment variables](https://vercel.com/docs/environment-variables), [Vercel Functions](https://vercel.com/docs/functions/functions-api-reference).
