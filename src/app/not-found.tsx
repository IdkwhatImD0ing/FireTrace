import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card max-w-md p-8 text-center">
        <p className="mono-label">404</p>
        <h1 className="mt-2 font-display text-4xl text-ink">Nothing recorded here.</h1>
        <p className="mt-2 text-sm text-ink-2">
          The page or trace you asked for does not exist, or was deleted.
        </p>
        <Link href="/projects" className="btn btn-ghost mt-6">
          Back to projects
        </Link>
      </div>
    </main>
  );
}
