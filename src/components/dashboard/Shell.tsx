import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "@/components/Brand";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import type { Owner } from "@/lib/auth/session";

export function Shell({ owner, children }: { owner: Owner; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg">
        <div className="mx-auto flex h-14 max-w-screen-2xl items-center gap-6 px-4 sm:px-6">
          <Link href="/projects" className="shrink-0" aria-label="FireTrace projects">
            <Brand size={24} />
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-1">
            <Link
              href="/projects"
              className="rounded-md px-3 py-1.5 font-mono text-[12px] uppercase tracking-wider text-ink-2 hover:text-ink"
            >
              Projects
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {owner.role === "trial" && (
              <span
                className="rounded border border-warn/60 bg-warn/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-2"
                title="Trial account: limited traces on this instance"
              >
                trial
              </span>
            )}
            <span
              className="hidden truncate font-mono text-[11px] text-ink-3 sm:inline"
              title={owner.email}
            >
              {owner.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
