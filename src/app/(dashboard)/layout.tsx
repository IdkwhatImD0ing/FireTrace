import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Shell } from "@/components/dashboard/Shell";
import { getOwner } from "@/lib/auth/session";
import { ConfigError } from "@/lib/env/server";

/** Session-gated pages: keep them out of search results. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Every dashboard page is behind a server-verified session cookie. */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  let owner = null;
  try {
    owner = await getOwner();
  } catch (err) {
    if (err instanceof ConfigError) redirect("/login");
    throw err;
  }
  if (!owner) redirect("/login");
  return <Shell owner={owner}>{children}</Shell>;
}
