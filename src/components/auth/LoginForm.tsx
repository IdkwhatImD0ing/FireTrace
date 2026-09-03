"use client";

import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  type User,
} from "firebase/auth";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authErrorMessage } from "@/lib/auth-errors";
import { firebaseClientAuth } from "@/lib/firebase/client";

type Mode = "signin" | "create";

async function exchangeForSession(
  user: User,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const idToken = await user.getIdToken(true);
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, error: body?.error?.message ?? `Sign-in failed (${res.status}).` };
}

export function LoginForm({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"google" | "email" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function finish(user: User) {
    const result = await exchangeForSession(user);
    if (!result.ok) {
      await firebaseClientAuth()?.signOut();
      setError(result.error);
      return;
    }
    router.replace("/projects");
    router.refresh();
  }

  async function withGoogle() {
    const auth = firebaseClientAuth();
    if (!auth) return;
    setBusy("google");
    setError(null);
    setNotice(null);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const credential = await signInWithPopup(auth, provider);
      await finish(credential.user);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function withEmail(e: FormEvent) {
    e.preventDefault();
    const auth = firebaseClientAuth();
    if (!auth) return;
    setBusy("email");
    setError(null);
    setNotice(null);
    try {
      if (mode === "create") {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await sendEmailVerification(credential.user);
        await auth.signOut();
        setNotice(
          `Account created. Verify ${email.trim()} using the link we just emailed, then sign in.`,
        );
        setMode("signin");
        return;
      }
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      if (!credential.user.emailVerified) {
        await sendEmailVerification(credential.user).catch(() => undefined);
        await auth.signOut();
        setError("Verify your email address first. We sent a new verification link.");
        return;
      }
      await finish(credential.user);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={withGoogle}
        disabled={!ready || busy !== null}
        className="btn btn-primary w-full"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z"
          />
          <path
            fill="currentColor"
            opacity=".8"
            d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"
          />
          <path
            fill="currentColor"
            opacity=".6"
            d="M6.4 14a6 6 0 0 1 0-3.8V7.6H3.1a10 10 0 0 0 0 9z"
          />
          <path
            fill="currentColor"
            opacity=".9"
            d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.6l3.3 2.6C7.2 7.8 9.4 6 12 6z"
          />
        </svg>
        {busy === "google" ? "Signing in…" : "Continue with Google"}
      </button>

      <div className="flex items-center gap-3 text-ink-3">
        <span className="h-px flex-1 bg-line" />
        <span className="mono-label">or email</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <form onSubmit={withEmail} className="space-y-3" noValidate>
        <label className="block">
          <span className="mono-label block">Email</span>
          <input
            className="input mt-1.5"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={!ready}
          />
        </label>
        <label className="block">
          <span className="mono-label block">Password</span>
          <input
            className="input mt-1.5"
            type="password"
            autoComplete={mode === "create" ? "new-password" : "current-password"}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "create" ? "At least 6 characters" : "••••••••"}
            disabled={!ready}
          />
        </label>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit-2"
          >
            {error}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-md border border-good/40 bg-good/10 px-3 py-2 text-sm text-ink"
          >
            {notice}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 pt-1">
          <button
            type="button"
            className="text-xs text-ink-3 hover:text-ink-2"
            onClick={() => {
              setMode(mode === "signin" ? "create" : "signin");
              setError(null);
              setNotice(null);
            }}
          >
            {mode === "signin"
              ? "First time? Create the owner account"
              : "Have an account? Sign in"}
          </button>
          <button type="submit" className="btn btn-ghost" disabled={!ready || busy !== null}>
            {busy === "email" ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </div>
      </form>
      <p className="text-xs leading-relaxed text-ink-3">
        Only verified emails on this deployment&apos;s allowlist can open the dashboard. Google
        accounts are verified automatically; email accounts must confirm the verification link
        first.
      </p>
    </div>
  );
}
