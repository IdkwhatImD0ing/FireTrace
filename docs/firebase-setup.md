# Firebase setup

This guide takes a new owner from nothing to a Firebase project that FireTrace can use: Firestore for storage, Firebase Authentication for dashboard sign-in, and a service-account credential for the server. Budget 15 minutes. Nothing here requires a paid plan.

Commands use `npx -y firebase-tools@latest` so no global install is needed. Replace `<PROJECT_ID>` with your Firebase project id throughout. Never commit credentials, `.env.local`, or your personal `.firebaserc`; all three are ignored by `.gitignore`.

## 1. Create a Firebase project

Sign in to the CLI, then create the project (or create it in the [Firebase console](https://console.firebase.google.com/) with **Add project**). New projects start on the Spark (free) plan, which is all FireTrace needs.

```bash
npx -y firebase-tools@latest login
npx -y firebase-tools@latest projects:create <PROJECT_ID> --display-name "FireTrace"
```

Project ids are global and permanent. You do not need Google Analytics.

## 2. Register a Web app

Register one Web app named `FireTrace Web` and print its configuration:

```bash
npx -y firebase-tools@latest apps:create WEB "FireTrace Web" --project <PROJECT_ID>
npx -y firebase-tools@latest apps:sdkconfig WEB <APP_ID> --project <PROJECT_ID>
```

`apps:create` prints the `<APP_ID>` (it looks like `1:123456789012:web:abcdef...`). From the `apps:sdkconfig` output, copy these four values into your environment (`.env.local` locally; Vercel later):

| Config key   | Environment variable               |
| ------------ | ---------------------------------- |
| `apiKey`     | `NEXT_PUBLIC_FIREBASE_API_KEY`     |
| `authDomain` | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` |
| `projectId`  | `NEXT_PUBLIC_FIREBASE_PROJECT_ID`  |
| `appId`      | `NEXT_PUBLIC_FIREBASE_APP_ID`      |

These values are public web configuration used by the browser for sign-in only (`src/lib/firebase/client.ts`). They are not secrets, but keep them out of git.

## 3. Create the Firestore database

In the console open **Build > Firestore Database > Create database** and choose:

- **Edition:** Standard.
- **Mode:** Native mode (not Datastore mode).
- **Location:** a region close to where Vercel will run your functions. **The location cannot be changed after creation**; moving later means creating a new database and migrating data yourself.
- **Security rules:** start in production mode. FireTrace deploys its own deny-all rules in step 7 regardless.

If you prefer the command line and have the Google Cloud SDK, the equivalent is `gcloud firestore databases create --location=<REGION> --project=<PROJECT_ID>`.

FireTrace never enables a Firestore TTL policy. Do not add one; age-based deletion is explicitly out of scope.

## 4. Enable Google sign-in

The committed `firebase.json` contains an `auth` block that the Firebase CLI can deploy (`deploy --only auth` is listed by `firebase-tools` 15 as "Deploys configuration settings for Firebase Authentication providers"). Edit it for your project:

```json
{
  "auth": {
    "authorizedDomains": ["localhost", "<PROJECT_ID>.firebaseapp.com", "<PROJECT_ID>.web.app"],
    "providers": {
      "emailPassword": true,
      "googleSignIn": {
        "oAuthBrandDisplayName": "FireTrace",
        "supportEmail": "<your-google-account-email>"
      }
    }
  }
}
```

- `supportEmail` becomes the support contact on the OAuth consent screen; it must be an email you control in the Google account that owns the project.
- `emailPassword: true` also enables the email/password form on the login page. Email/password accounts must verify their address before the allowlist lets them in (`src/lib/auth/session.ts`). Set it to `false` if you want Google only; the form then fails with an "operation not allowed" message.

Deploy the auth configuration:

```bash
npx -y firebase-tools@latest deploy --only auth --project <PROJECT_ID>
```

If your CLI version rejects the `auth` target, enable the providers in the console instead: **Build > Authentication > Get started > Sign-in method > Google > Enable**, then set the support email.

The committed `firebase.json` in this repository contains the original author's project domains and support email; replace them with yours.

## 5. Authorized domains

Firebase only completes sign-in on hostnames listed under **Authentication > Settings > Authorized domains**. The list needs:

- `localhost` (local development against the real project),
- `<PROJECT_ID>.firebaseapp.com` and `<PROJECT_ID>.web.app` (added by default),
- your Vercel production hostname (`<project>.vercel.app`),
- any custom domain you attach in Vercel.

Add them to `authorizedDomains` in `firebase.json` and run the `deploy --only auth` command again, or add them in the console. Entries are exact hostnames; preview deployments with generated hostnames must be added individually if you want to sign in on them.

## 6. Associate the repository with the project

The Firebase CLI reads the active project from `.firebaserc`, which is gitignored so that forks do not inherit someone else's project id. Create yours from the template:

```bash
cp .firebaserc.example .firebaserc
# edit .firebaserc and replace "your-firebase-project-id" with <PROJECT_ID>
```

Alternatively pass `--project <PROJECT_ID>` to every command, as this guide does.

## 7. Deploy Firestore rules and indexes

```bash
npx -y firebase-tools@latest deploy --only firestore --project <PROJECT_ID>
```

This deploys `firestore.rules` (deny all direct client reads and writes) and `firestore.indexes.json` (the composite indexes used by the trace list filters, plus single-field exemptions that keep `input`, `output`, `metadata`, `attributes`, and `events` out of the index). Composite indexes take a few minutes to build; the console shows their status under **Firestore Database > Indexes**. Until they are ready, filtered trace lists return an error.

`pnpm firebase:deploy` runs `deploy --only firestore,auth` and relies on `.firebaserc` from step 6 (or append `--project <PROJECT_ID>`).

## 8. Create the Admin service-account credential

The server uses the Firebase Admin SDK, which needs a service account. In the console open **Project settings > Service accounts > Firebase Admin SDK > Generate new private key** and download the JSON file. Treat it like a root password: it bypasses Firestore rules.

Encode the whole file as one base64 line and put it in `FIREBASE_SERVICE_ACCOUNT_BASE64`:

```bash
# Linux
base64 -w0 service-account.json
# macOS
base64 -i service-account.json | tr -d '\n'
```

PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))`

Then delete the downloaded JSON file or move it outside the repository. The server decodes the value in memory (`src/lib/firebase/admin.ts`) and never writes it to disk. `src/lib/env/server.ts` verifies at startup that the value decodes to a JSON object with `"type": "service_account"`.

For local development against the real project you may leave `FIREBASE_SERVICE_ACCOUNT_BASE64` empty and use Application Default Credentials instead (`gcloud auth application-default login` with an account that has Editor or Owner on the project). Production fails closed without the base64 value.

## 9. Configure the owner email, the key pepper, and the app URL

Set these server-only values in `.env.local` now and in Vercel later (see `.env.example` for all variables):

- `DASHBOARD_ALLOWED_EMAILS`: comma-separated emails allowed into the dashboard. Every listed address is a co-owner with access to every project. Addresses are compared lower-cased and must be verified in Firebase (Google accounts are verified automatically). Production refuses to start when this is empty.
- `FIRETRACE_KEY_PEPPER`: a random secret of at least 32 characters used to HMAC project API keys. Generate one with `openssl rand -base64 48`. Changing it later invalidates every existing API key, so store it somewhere safe.
- `NEXT_PUBLIC_APP_URL`: the canonical origin of the deployment without a trailing slash (`http://localhost:3000` locally). It is used for Origin checks on cookie-authenticated requests and in the copyable setup snippets.
- `FIRETRACE_USE_EMULATORS` and `NEXT_PUBLIC_FIRETRACE_USE_EMULATORS`: `false` whenever you talk to the real project.

## 10. Smoke test locally against the real project

1. With `.env.local` complete and `FIRETRACE_USE_EMULATORS=false`, run `pnpm install`, `pnpm typegen`, and `pnpm dev`.
2. Open <http://localhost:3000/api/health>. Expect `firebaseConfigured`, `authConfigured`, and `ingestConfigured` all `true`; outside production the response also lists any `problems`.
3. Open <http://localhost:3000/login> and sign in with the allowlisted Google account. An address that is not on the list is rejected with a message naming the email.
4. Create a project, open **Settings**, create an API key, and copy it; it is shown once.
5. Send the example trace with the SDK and open the printed URL:

   ```bash
   FIRETRACE_ENDPOINT=http://localhost:3000 FIRETRACE_API_KEY=ft_live_... pnpm trace:example
   ```

If a trace appears with an agent root, a tool span, and an LLM span, Firebase is ready. Continue with [vercel-deployment.md](vercel-deployment.md).

## Reference

- [Firebase CLI](https://firebase.google.com/docs/cli/)
- [Firebase Admin SDK setup](https://firebase.google.com/docs/admin/setup)
- [Firebase session cookies](https://firebase.google.com/docs/auth/admin/manage-cookies)
- [Firestore pricing and free quota](https://firebase.google.com/docs/firestore/pricing)
- [Firestore emulator](https://firebase.google.com/docs/emulator-suite/connect_firestore)
