"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
      const { firebaseClientAuth } = await import("@/lib/firebase/client");
      await firebaseClientAuth()?.signOut();
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <button type="button" onClick={signOut} className="btn btn-ghost btn-sm" disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
