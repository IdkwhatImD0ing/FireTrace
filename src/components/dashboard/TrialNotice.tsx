import Link from "next/link";
import { deployYourOwnUrl } from "@/lib/firetrace/trial";

/**
 * What a trial account sees about its quota, and what an owner sees on a
 * trial user's project. Server component; data comes from trialUsage/{uid}.
 */
export function TrialNotice({
  used,
  limit,
  repositoryUrl,
  viewer,
  ownerEmail,
}: {
  used: number;
  limit: number;
  repositoryUrl: string;
  viewer: "trial" | "owner";
  ownerEmail?: string | null;
}) {
  const exhausted = used >= limit;
  const deployUrl = deployYourOwnUrl(repositoryUrl);
  const promptUrl = `${repositoryUrl.replace(/\/+$/, "")}/blob/main/docs/deploy-prompt.md`;

  if (viewer === "owner") {
    return (
      <p className="font-mono text-[11px] text-ink-3" data-testid="trial-owner-note">
        Trial project{ownerEmail ? ` · ${ownerEmail}` : ""} · {used} of {limit} traces used
      </p>
    );
  }

  if (exhausted) {
    return (
      <section
        role="alert"
        aria-labelledby="trial-exhausted-title"
        className="card border-ember/60 bg-ember-dim p-5"
        data-testid="trial-exhausted"
      >
        <p className="mono-label text-ember-2">Trial complete</p>
        <h2 id="trial-exhausted-title" className="mt-1 font-display text-2xl text-ink">
          You&apos;ve used all {limit} trial traces.
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-2">
          This instance is its owner&apos;s personal deployment, so trial accounts stop at {limit}{" "}
          traces. Everything you recorded stays readable here. For unlimited traces and infinite
          retention, deploy your own FireTrace: it runs on a free Firebase project and a free Vercel
          account, and an AI agent can do the setup for you from one prompt.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href={deployUrl} className="btn btn-primary" target="_blank" rel="noreferrer">
            Deploy your own
          </a>
          <a href={promptUrl} className="btn btn-ghost" target="_blank" rel="noreferrer">
            Prompt for your AI agent
          </a>
        </div>
      </section>
    );
  }

  return (
    <p
      role="status"
      className="rounded-md border border-line bg-bg-2 px-3 py-2 text-sm text-ink-2"
      data-testid="trial-status"
    >
      <span className="font-mono text-[11px] uppercase tracking-wider text-ember-2">Trial</span>{" "}
      {used} of {limit} traces used on this instance. It is the owner&apos;s personal deployment;
      when the {limit} are used up, recording stops.{" "}
      <a href={deployUrl} className="underline" target="_blank" rel="noreferrer">
        Deploy your own
      </a>{" "}
      for unlimited retention, or{" "}
      <Link href="/projects" className="underline">
        keep exploring
      </Link>
      .
    </p>
  );
}
