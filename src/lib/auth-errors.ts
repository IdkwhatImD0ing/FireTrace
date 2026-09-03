import { FirebaseError } from "firebase/app";

const MESSAGES: Record<string, string> = {
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/wrong-password": "Email or password is incorrect.",
  "auth/user-not-found": "Email or password is incorrect.",
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/email-already-in-use": "An account with that email already exists. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/missing-password": "Enter a password.",
  "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  "auth/network-request-failed": "Network error. Check your connection and try again.",
  "auth/user-disabled": "This account has been disabled.",
};

export function authErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    return MESSAGES[err.code] ?? `Something went wrong (${err.code}).`;
  }
  return "Something went wrong. Try again.";
}
