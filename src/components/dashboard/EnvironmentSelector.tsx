"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  ALL_ENVIRONMENTS,
  ENVIRONMENT_COOKIE,
  UNASSIGNED_ENVIRONMENT,
} from "@/lib/firetrace/environment";

/**
 * The project-wide environment switch. Writes the choice to a cookie and
 * re-renders the server components, so every list and every number on every
 * project page follows it; nothing is filtered per view.
 */
export function EnvironmentSelector({
  selection,
  options,
}: {
  selection: string;
  /** Environments the project's keys carry, production first. */
  options: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function choose(value: string) {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${ENVIRONMENT_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    startTransition(() => router.refresh());
  }

  const specific = selection !== ALL_ENVIRONMENTS;
  return (
    <label className="flex items-center gap-2">
      <span className="mono-label">Environment</span>
      <select
        name="environment"
        aria-label="Environment"
        className={`input w-auto py-1 pr-8 font-mono text-xs ${
          specific ? "border-ember text-ember-2" : ""
        }`}
        value={selection}
        onChange={(e) => choose(e.target.value)}
        disabled={pending}
      >
        <option value={ALL_ENVIRONMENTS}>all environments</option>
        {options.map((env) => (
          <option key={env} value={env}>
            {env}
          </option>
        ))}
        <option value={UNASSIGNED_ENVIRONMENT}>unassigned</option>
      </select>
    </label>
  );
}
