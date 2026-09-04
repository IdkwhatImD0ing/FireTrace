import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Brand } from "@/components/Brand";
import { DocsNav } from "@/components/docs/DocsNav";
import { getOwner } from "@/lib/auth/session";
import { DEFAULT_REPOSITORY_URL } from "@/lib/env/server";

export const metadata: Metadata = {
  title: { default: "Docs", template: "%s · FireTrace docs" },
  description: "Guides and reference for deploying and using FireTrace.",
};

/**
 * The header shows the visitor's own session state, so the docs route renders
 * per request instead of being prerendered. The pages themselves stay public.
 */
export const dynamic = "force-dynamic";

/** Public documentation shell: no session required, rendered from docs/*.md. */
export default async function DocsLayout({ children }: { children: ReactNode }) {
  const repoUrl = (process.env.NEXT_PUBLIC_REPOSITORY_URL || DEFAULT_REPOSITORY_URL).replace(
    /\/+$/,
    "",
  );
  const owner = await getOwner();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg">
        <div className="mx-auto flex h-14 max-w-screen-2xl items-center gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="FireTrace home" className="shrink-0">
            <Brand size={24} />
          </Link>
          <Link
            href="/docs"
            className="rounded-md px-2 py-1 font-mono text-[12px] uppercase tracking-wider text-ink-2 hover:text-ink"
          >
            Docs
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <a href={repoUrl} className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer">
              GitHub
            </a>
            {owner ? (
              <Link href="/projects" className="btn btn-primary btn-sm">
                Projects
              </Link>
            ) : (
              <Link href="/login" className="btn btn-primary btn-sm">
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-8 sm:px-6 lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
        <aside className="mb-8 lg:sticky lg:top-20 lg:mb-0 lg:self-start">
          <details className="lg:hidden">
            <summary className="btn btn-ghost btn-sm cursor-pointer select-none">
              Browse docs
            </summary>
            <div className="mt-3">
              <DocsNav />
            </div>
          </details>
          <div className="hidden lg:block">
            <DocsNav />
          </div>
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
