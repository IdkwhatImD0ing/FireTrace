import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/Brand";
import { LoginForm } from "@/components/auth/LoginForm";
import { getOwner } from "@/lib/auth/session";
import { clientEnvProblems } from "@/lib/env/client";
import { configStatus, trialTraceLimitFromEnv } from "@/lib/env/server";

export const metadata: Metadata = { title: "Sign in" };

/** Configuration status must be evaluated per request, never baked in at build time. */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const status = configStatus();
  if (status.firebaseConfigured && status.authConfigured) {
    const owner = await getOwner();
    if (owner) redirect("/projects");
  }
  const clientProblems = clientEnvProblems();
  const ready = status.authConfigured && status.firebaseConfigured && clientProblems.length === 0;
  const showDetails = process.env.NODE_ENV !== "production";
  const trialLimit = trialTraceLimitFromEnv();

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="card w-full max-w-md p-8">
        <Link href="/" className="inline-flex" aria-label="FireTrace home">
          <Brand />
        </Link>
        <h1 className="mt-8 font-display text-4xl leading-[1.05] text-ink">
          Open the <em className="text-ember-2">record.</em>
        </h1>
        <p className="mt-2 text-sm text-ink-2">
          {trialLimit > 0
            ? `Sign in with an allowlisted account. Any other verified account gets a trial: ${trialLimit} traces on this instance, then a pointer to deploy your own.`
            : "Sign in with an allowlisted account."}
        </p>

        {!ready && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-warn/40 bg-warn/10 px-3 py-3 text-sm text-ink"
          >
            <p className="font-medium">This deployment is not fully configured.</p>
            <p className="mt-1 text-ink-2">
              The owner needs to set the Firebase Web app values, the Admin credential, and{" "}
              <code className="font-mono">DASHBOARD_ALLOWED_EMAILS</code>. See
              docs/firebase-setup.md.
            </p>
            {showDetails && (
              <ul className="mt-2 list-disc pl-5 font-mono text-xs text-ink-2">
                {[...status.problems, ...clientProblems].map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="mt-8">
          <LoginForm ready={ready} trialLimit={trialLimit} />
        </div>
      </div>
    </main>
  );
}
