# Deploy FireTrace with an AI agent

Copy the prompt below into an AI coding agent that can run commands on your machine (Claude Code, Codex CLI, Cursor, Gemini CLI, and similar) and let it do the deployment. It works through [firebase-setup.md](./firebase-setup.md) and [vercel-deployment.md](./vercel-deployment.md) for you, stops for the steps that need your browser (Google and Vercel sign-in, OAuth consent), and keeps your secrets out of the chat.

You need: Node.js 22+, git, a Google account, and a Vercel account. Nothing requires a paid plan. Budget 20 to 30 minutes, mostly waiting on sign-in prompts.

A shorter alternative is to hand the agent this file directly: `Fetch https://raw.githubusercontent.com/IdkwhatImD0ing/FireTrace/main/docs/deploy-prompt.md and follow the prompt in it to deploy FireTrace for me.`

## The prompt

```text
Deploy FireTrace for me. FireTrace is an open-source, self-hosted LLM/agent tracing app: a Next.js dashboard on Vercel backed by a Firebase project (Firestore + Authentication) that I own. Repository: https://github.com/IdkwhatImD0ing/FireTrace. Its docs/firebase-setup.md and docs/vercel-deployment.md are the source of truth; this prompt is the checklist. Work in my terminal and report progress after each numbered step. Commands are written for bash/zsh; where PowerShell differs a PowerShell form follows. Run one command per line rather than chaining with && (Windows PowerShell 5.1 rejects it).

GROUND RULES
- Ask me before anything that costs money and before any destructive or irreversible action (deleting projects or databases, rotating secrets, force-pushing).
- Never commit secrets. .env.local and .firebaserc are gitignored; service-account key files are ignored only when their name contains "service-account" or "-firebase-adminsdk-", so keep the key outside the repository (../firetrace-service-account.json) and never copy it into the clone. Never paste the service-account JSON, its base64 form, or the key pepper into this chat, and never run a command that prints them to the terminal; the recipes below write them straight into files. Refer to them by name only.
- Use `npx -y firebase-tools@latest` (never a bare `firebase`), the Vercel CLI (`npm i -g vercel` if missing), and pnpm inside the repo (never npm or yarn for the repo itself).
- Stop and ask me when a step needs a browser: CLI sign-ins, OAuth consent screens, console-only actions, or downloading a service-account key. Do not try to automate sign-in.
- Do not enable any Firestore TTL policy, scheduled cleanup, or age-based deletion; infinite retention is the point of this app.

INPUTS (ask me for any that are missing before you start)
- FIREBASE_PROJECT_ID: a new, globally unique, lowercase Firebase project id (letters, digits, hyphens).
- OWNER_EMAIL: the Google account email that will sign in to the dashboard. It becomes the allowlist and the OAuth support email.
- FIRESTORE_LOCATION: a Firestore location such as nam5, us-east1, or eur3. It cannot be changed later.
- VERCEL_PROJECT_NAME (optional, default firetrace): lowercase letters, digits, '.', '_' or '-' only, no '---', at most 100 characters. It is also the clone folder and the default hostname <name>.vercel.app.
- VERCEL_TEAM (optional): the Vercel team slug to create the project in, if my account belongs to more than one team.
- REPO_URL (optional): my fork of the repository if I have one; otherwise clone the upstream repository.

STEPS
1. Prepare the repository.
   git clone <REPO_URL or https://github.com/IdkwhatImD0ing/FireTrace.git> <VERCEL_PROJECT_NAME>
   cd <VERCEL_PROJECT_NAME>
   Confirm `node --version` is 22 or newer. Make pnpm 10 available: `corepack enable`; if corepack is not found (Node 25 and newer no longer bundle it) or fails with EPERM on Windows, run `npm install -g pnpm@10` instead. Then: pnpm install; pnpm typegen. Copy .env.example to .env.local and .firebaserc.example to .firebaserc (cp on macOS/Linux, Copy-Item on PowerShell). Put FIREBASE_PROJECT_ID into .firebaserc in place of "your-firebase-project-id".

2. Create the Firebase project.
   Firebase CLI sign-in cannot complete from an agent shell (the CLI switches to a non-interactive flow that needs a code typed back). Ask me to run `npx -y firebase-tools@latest login` in my own terminal and tell you when it is done; the credential is stored in the CLI's global config and your later commands use it. Check with: npx -y firebase-tools@latest login:list
   npx -y firebase-tools@latest projects:create <FIREBASE_PROJECT_ID> --display-name "FireTrace"
   If the id is taken, ask me for another one. Google Analytics is not needed.

3. Register the Web app and capture its public config.
   npx -y firebase-tools@latest apps:create WEB "FireTrace Web" --project <FIREBASE_PROJECT_ID>
   npx -y firebase-tools@latest apps:sdkconfig WEB <APP_ID printed above> --project <FIREBASE_PROJECT_ID>
   Write apiKey, authDomain, projectId, and appId into .env.local as NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, NEXT_PUBLIC_FIREBASE_PROJECT_ID, NEXT_PUBLIC_FIREBASE_APP_ID. These four are public browser config, not secrets, so editing the file directly is fine.

4. Create the Firestore database and pin its location.
   npx -y firebase-tools@latest firestore:databases:create "(default)" --location <FIRESTORE_LOCATION> --edition standard --project <FIREBASE_PROJECT_ID>
   Also add "location": "<FIRESTORE_LOCATION>" inside the "firestore" block of firebase.json, next to "rules" and "indexes": step 6 would otherwise create a missing (default) database in nam5, and a database location can never be changed.
   Alternatives if the command is unavailable or I prefer: with gcloud (`gcloud auth login`), run `gcloud services enable firestore.googleapis.com --project=<FIREBASE_PROJECT_ID>` and then `gcloud firestore databases create --location=<FIRESTORE_LOCATION> --type=firestore-native --edition=standard --project=<FIREBASE_PROJECT_ID>`; or ask me to create it in the Firebase console (Build > Firestore Database > Create database > Standard edition > Native mode > production rules).

5. Configure the sign-in providers.
   In firebase.json set the "auth" block to providers only: providers.emailPassword = true, providers.googleSignIn.oAuthBrandDisplayName = "FireTrace", providers.googleSignIn.supportEmail = OWNER_EMAIL. Remove any "authorizedDomains" key if one is present: the CLI does not manage authorized domains (that is step 10). The committed file may still hold the original author's support email; replace it.
   npx -y firebase-tools@latest deploy --only auth --project <FIREBASE_PROJECT_ID>
   If the CLI rejects the auth target, ask me to enable Google and Email/Password under Build > Authentication > Sign-in method in the console, with OWNER_EMAIL as the support email.

6. Deploy Firestore rules and indexes (deny-all rules; the app reads and writes only through the Admin SDK on the server). This also creates the database from step 4 when it does not exist.
   npx -y firebase-tools@latest deploy --only firestore --project <FIREBASE_PROJECT_ID>
   Verify the location: npx -y firebase-tools@latest firestore:databases:list --project <FIREBASE_PROJECT_ID> must show (default) at FIRESTORE_LOCATION. Composite indexes take a few minutes to build; you do not need to wait.

7. Create the Admin SDK service-account credential.
   Preferred, with gcloud: gcloud iam service-accounts list --project <FIREBASE_PROJECT_ID> to find the account named like firebase-adminsdk-xxxxx@<FIREBASE_PROJECT_ID>.iam.gserviceaccount.com, then
   gcloud iam service-accounts keys create ../firetrace-service-account.json --iam-account=<that email> --project <FIREBASE_PROJECT_ID>
   Without gcloud (or if key creation is blocked by an organization policy): ask me to download a key from Project settings > Service accounts > Firebase Admin SDK > Generate new private key and save it as ../firetrace-service-account.json (outside the repository).
   Write it into .env.local as one base64 line without printing it, on any platform:
   node -e "const fs=require('fs');const b=fs.readFileSync(process.argv[1]).toString('base64');const p='.env.local';fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/^FIREBASE_SERVICE_ACCOUNT_BASE64=[^\r\n]*/m,'FIREBASE_SERVICE_ACCOUNT_BASE64='+b))" ../firetrace-service-account.json
   (Manual equivalents that print to stdout, only if I ask: Linux `base64 -w0 <file>`, macOS `base64 -i <file> | tr -d '\n'`.)

8. Fill in the remaining .env.local values.
   DASHBOARD_ALLOWED_EMAILS=<OWNER_EMAIL>
   FIRETRACE_KEY_PEPPER: generate a random secret straight into the file, without printing it:
   node -e "const fs=require('fs');const p='.env.local';const s=require('crypto').randomBytes(48).toString('base64');fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace(/^FIRETRACE_KEY_PEPPER=[^\r\n]*/m,'FIRETRACE_KEY_PEPPER='+s))"
   Tell me to store the pepper somewhere safe (it is in .env.local): changing it later invalidates every API key.
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   FIRETRACE_USE_EMULATORS=false and NEXT_PUBLIC_FIRETRACE_USE_EMULATORS=false
   Leave FIRETRACE_STORAGE_LIMIT_BYTES unset (optional storage-warning allowance in bytes; the default is the 1 GiB free tier). Leave FIRETRACE_TRIAL_TRACE_LIMIT unset unless I say I want strangers to be able to sign in and try a few traces on my instance. Leave FIRETRACE_EVAL_BASE_URL, FIRETRACE_EVAL_API_KEY and FIRETRACE_EVAL_MODEL unset unless I say I want LLM-as-a-judge evaluators; they point at any OpenAI-compatible chat-completions endpoint and are set all together or not at all.
   Then verify locally: start `pnpm dev` in the background, GET http://localhost:3000/api/health (curl on macOS/Linux; Invoke-RestMethod on PowerShell) and confirm firebaseConfigured, authConfigured, and ingestConfigured are all true (the response lists any problems outside production). If port 3000 is busy, use `pnpm exec next dev --port 3001` and adjust the URL. Afterwards stop the dev server and make sure nothing still listens on the port: macOS/Linux `lsof -ti :3000 | xargs kill`; PowerShell `Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`.

9. Create the Vercel project and set its environment variables (Production environment).
   Ask me to run `vercel login` in my own terminal (it is a device-code flow that blocks until I approve it in the browser) and tell you when it is done; the token is stored in the CLI's global config. Check with: vercel whoami
   vercel link --yes --project <VERCEL_PROJECT_NAME>     (run from the repository root; the CLI runs non-interactively for agents and needs --project; it creates the project if it does not exist. Add --scope <VERCEL_TEAM> when I gave you a team; if the CLI answers missing_scope, ask me for the team slug and retry with --scope.)
   Non-secret values, one command each: vercel env add <NAME> production --value "<value>" --no-sensitive --yes
     NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, NEXT_PUBLIC_FIREBASE_PROJECT_ID, NEXT_PUBLIC_FIREBASE_APP_ID, DASHBOARD_ALLOWED_EMAILS, NEXT_PUBLIC_APP_URL (use https://<VERCEL_PROJECT_NAME>.vercel.app for now)
   The two secrets, FIREBASE_SERVICE_ACCOUNT_BASE64 and FIRETRACE_KEY_PEPPER, are piped from .env.local on stdin so the value never appears in a command line, a process list, or the chat:
     bash/zsh:  grep '^FIRETRACE_KEY_PEPPER=' .env.local | cut -d= -f2- | vercel env add FIRETRACE_KEY_PEPPER production --sensitive --yes
     PowerShell: ((Get-Content .env.local) -match '^FIRETRACE_KEY_PEPPER=')[0] -replace '^FIRETRACE_KEY_PEPPER=','' | vercel env add FIRETRACE_KEY_PEPPER production --sensitive --yes
     and the same two forms with FIREBASE_SERVICE_ACCOUNT_BASE64. Afterwards `vercel env ls production` must list all eight names. Production values are sensitive by default in current CLIs; --sensitive makes it explicit, and sensitive values can never be read back. If the CLI rejects --sensitive, add them without it and tell me to mark them Sensitive in the Vercel dashboard.
   Do not set FIRETRACE_USE_EMULATORS, NEXT_PUBLIC_FIRETRACE_USE_EMULATORS, or the emulator host variables; production refuses to start with the emulator flag on. Preview environments are optional and share the same Firestore unless given their own Firebase project; skip them unless I ask.

10. Deploy and authorize the hostname for sign-in.
   vercel deploy --prod --yes. The output has two URLs: the `Production:` line is a per-deployment URL that changes every deploy; the `Aliased:` line is the stable hostname (<name>.vercel.app). Use the stable hostname everywhere below. If it differs from the NEXT_PUBLIC_APP_URL you set, update that variable (vercel env rm NEXT_PUBLIC_APP_URL production --yes, then add it again with --no-sensitive) and deploy again.
   Firebase only completes sign-in on hostnames in its authorized-domains list, and the Firebase CLI cannot edit that list, so add the Vercel hostname now, one of these ways:
   - With gcloud: read the current list, then write it back with the new hostname appended (the body replaces the whole list; keep localhost, <FIREBASE_PROJECT_ID>.firebaseapp.com and <FIREBASE_PROJECT_ID>.web.app).
     bash/zsh:  curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: <FIREBASE_PROJECT_ID>" https://identitytoolkit.googleapis.com/admin/v2/projects/<FIREBASE_PROJECT_ID>/config
                curl -s -X PATCH "https://identitytoolkit.googleapis.com/admin/v2/projects/<FIREBASE_PROJECT_ID>/config?updateMask=authorizedDomains" -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: <FIREBASE_PROJECT_ID>" -H "Content-Type: application/json" -d '{"authorizedDomains":["localhost","<FIREBASE_PROJECT_ID>.firebaseapp.com","<FIREBASE_PROJECT_ID>.web.app","<hostname>"]}'
     PowerShell: $h=@{Authorization="Bearer $(gcloud auth print-access-token)";'x-goog-user-project'='<FIREBASE_PROJECT_ID>'}
                Invoke-RestMethod -Headers $h https://identitytoolkit.googleapis.com/admin/v2/projects/<FIREBASE_PROJECT_ID>/config
                Invoke-RestMethod -Method Patch -Headers $h -ContentType 'application/json' -Body '{"authorizedDomains":["localhost","<FIREBASE_PROJECT_ID>.firebaseapp.com","<FIREBASE_PROJECT_ID>.web.app","<hostname>"]}' 'https://identitytoolkit.googleapis.com/admin/v2/projects/<FIREBASE_PROJECT_ID>/config?updateMask=authorizedDomains'
   - Without gcloud: ask me to add the hostname under Build > Authentication > Settings > Authorized domains in the Firebase console and wait for my confirmation.
   Sign-in on a hostname that is not on the list fails with auth/unauthorized-domain.

11. Verify the deployment.
   GET https://<hostname>/api/health must return {"ok":true,"firebaseConfigured":true,"authConfigured":true,"ingestConfigured":true,"emulators":false}. GET https://<hostname>/api/v1 lists the API endpoints and GET https://<hostname>/api/v1/openapi.json returns the OpenAPI document.
   Then ask me to open https://<hostname>/login, sign in with OWNER_EMAIL through Google, create a project, open its Settings, and create an API key. I will keep the key myself. For the end-to-end check, ask me to run in my own terminal (do not ask me to paste the key into chat):
     bash/zsh:  FIRETRACE_ENDPOINT=https://<hostname> FIRETRACE_API_KEY=ft_live_... pnpm trace:example
     PowerShell: $env:FIRETRACE_ENDPOINT="https://<hostname>"; $env:FIRETRACE_API_KEY="ft_live_..."; pnpm trace:example
   The first run prints `Stored trace <id> (3 spans) in project <projectId>` and a `View it:` URL; a second run prints `Duplicate of existing trace ...` (the API answered 200 with duplicate: true) and stores nothing new. Confirm with me that the trace page shows the tree, the waterfall, and the inspector.

12. Optional extras, only if I want them.
   - Auto-deploys from git: if the clone is my own fork pushed to GitHub, run `vercel git connect` so pushes to main deploy production.
   - MCP for AI agents: the deployment serves it at https://<hostname>/api/mcp with the same API key; for Claude Code: claude mcp add --transport http firetrace https://<hostname>/api/mcp --header "Authorization: Bearer <key>". See docs/mcp.md.
   - Custom domain: add it in Vercel, authorize the hostname in Firebase as in step 10, update NEXT_PUBLIC_APP_URL, redeploy.

13. Finish.
   Delete ../firetrace-service-account.json after confirming with me (the base64 copy in Vercel is what production uses; .env.local keeps a local copy for development). Confirm that .env.local and .firebaserc are untracked and that no service-account file is inside the clone (`git status --short` shows none of them).
   Report: Firebase project id, Firestore location, Web app id, Vercel project and production URL, the allowlisted email, which environment variables were set in Vercel (names only), and any step you had to skip or that I completed manually. Remind me that the key pepper and the service-account credential must be stored safely, that the Firestore free tier is 1 GiB and FireTrace never deletes data on its own, and that anything else about the app is in the repository README.
```

## What the agent will ask you for

- Your chosen Firebase project id, your Google account email, and a Firestore location.
- To run the two CLI sign-ins (`npx -y firebase-tools@latest login`, `vercel login`) in your own terminal, since both need a browser and a code exchange that an agent shell cannot complete, and possibly to download the service-account key or add the Vercel hostname to Firebase's authorized domains in the console if `gcloud` is not installed.
- To sign in to the finished dashboard and create the first API key. The key stays with you; the prompt tells the agent not to ask for it in chat.

## What it will not do

- Enable a TTL, cleanup job, or any age-based deletion. Infinite retention is by design.
- Loosen `firestore.rules`; every read and write goes through the server.
- Commit `.env.local`, `.firebaserc`, or the service-account file (kept outside the repository; `.gitignore` also covers the usual key file names), or print secret values into the conversation. The service-account credential and the key pepper are written into `.env.local` by small Node one-liners and passed to Vercel by reading that file in the shell.

If something goes wrong, the two guides it follows have troubleshooting sections: [firebase-setup.md](./firebase-setup.md) and [vercel-deployment.md](./vercel-deployment.md).
