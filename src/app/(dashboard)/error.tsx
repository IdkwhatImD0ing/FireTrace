"use client";

import Link from "next/link";
import { useEffect } from "react";

/** Route-level error boundary for the dashboard. Never renders server details. */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("dashboard error", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="card max-w-xl p-8" role="alert">
      <p className="mono-label">Something went wrong</p>
      <h1 className="mt-2 font-display text-3xl text-ink">This page could not be loaded.</h1>
      <p className="mt-2 text-sm text-ink-2">
        The server logged the details{error.digest ? ` (digest ${error.digest})` : ""}. If this
        keeps happening, check the deployment&apos;s environment variables and Firebase credentials.
      </p>
      <div className="mt-6 flex gap-2">
        <button type="button" className="btn btn-primary" onClick={reset}>
          Try again
        </button>
        <Link href="/projects" className="btn btn-ghost">
          Back to projects
        </Link>
      </div>
    </div>
  );
}
