import Link from "next/link";
import { Brand } from "@/components/Brand";
import { TraceExplorer } from "@/components/trace/TraceExplorer";
import { normalizeIngestBody } from "@/lib/firetrace/normalize";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import type { SpanDetail, TraceDetail } from "@/lib/firetrace/types";
import { getOwner } from "@/lib/auth/session";
import { publicRepositoryUrl, trialTraceLimitFromEnv } from "@/lib/env/server";

const REPO_URL = publicRepositoryUrl();

type Preview = { trace: TraceDetail; spans: SpanDetail[] };

/** The sample is a constant: normalize and hash it once per process, not per request. */
let preview: Preview | undefined;
function previewData(): Preview {
  return (preview ??= buildPreview());
}

function buildPreview(): Preview {
  const normalized = normalizeIngestBody(sampleTraceRequest());
  if (!normalized.ok) throw new Error("sample trace is invalid");
  const { trace, spans, bodyHash, estimatedBytes } = normalized.value;
  return {
    trace: {
      ...trace,
      provider: trace.provider ?? null,
      model: trace.model ?? null,
      sessionId: trace.sessionId ?? null,
      userId: trace.userId ?? null,
      costUsd: trace.costUsd ?? null,
      input: trace.input ?? null,
      output: trace.output ?? null,
      bodyHash,
      estimatedBytes,
      ingestedAt: trace.endedAt,
      metadataUpdatedAt: null,
      scores: {},
      environment: null,
    },
    spans: spans.map((s) => ({
      ...s,
      provider: s.provider ?? null,
      model: s.model ?? null,
      input: s.input ?? null,
      output: s.output ?? null,
      usage: s.usage ?? null,
      costUsd: s.costUsd ?? null,
      events: s.events.map((e) => ({ ...e, attributes: e.attributes ?? null })),
    })),
  };
}

const POINTS = [
  {
    title: "Yours, not rented",
    body: "Deploy the Next.js app to Vercel and point it at a Firebase project you own. Traces live in your Firestore database; FireTrace has no servers of its own.",
  },
  {
    title: "No expiry, ever",
    body: "There is no TTL field, no cleanup job and no age-based deletion path. Traces stay until you delete them or your Firebase storage is full.",
  },
  {
    title: "One POST per run",
    body: "A small TypeScript SDK or a single curl call records a complete trace with nested spans, inputs, outputs, tokens, cost, errors and tags.",
  },
];

/** The trial invite and the session-aware header must reflect the request, never a build-time snapshot. */
export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const TRIAL_LIMIT = trialTraceLimitFromEnv();
  const owner = await getOwner();
  const preview = previewData();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href="/" aria-label="FireTrace home">
            <Brand />
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/docs" className="btn btn-ghost btn-sm">
              Docs
            </Link>
            <a href={REPO_URL} className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer">
              View GitHub
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

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 sm:px-6">
        <section className="py-16 lg:py-24">
          <p className="mono-label">Self-deployed LLM tracing</p>
          <h1 className="mt-5 max-w-4xl font-display text-[clamp(2.75rem,7vw,5.5rem)] leading-[0.98] tracking-[-0.01em] text-ink">
            LLM traces that <em className="text-ember-2">do not expire.</em>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-ink-2">
            Run FireTrace in your own Firebase account and keep every agent run, prompt and tool
            call until you choose to delete it. Infinite retention is time-unlimited, not
            storage-unlimited: capacity is bounded by your Firebase plan (1 GiB on the current free
            tier).
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href={`${REPO_URL}#deploy-your-own`}
              className="btn btn-primary"
              target="_blank"
              rel="noreferrer"
            >
              Deploy your own
            </a>
            <a href={REPO_URL} className="btn btn-ghost" target="_blank" rel="noreferrer">
              View GitHub
            </a>
          </div>
          {TRIAL_LIMIT > 0 && !owner && (
            <p className="mt-4 max-w-2xl text-sm text-ink-2" data-testid="trial-invite">
              This instance is its owner&apos;s personal deployment. You can{" "}
              <Link href="/login" className="underline">
                sign in
              </Link>{" "}
              with any verified Google or email account and record up to {TRIAL_LIMIT} traces to try
              it, then deploy your own for unlimited retention.
            </p>
          )}
        </section>

        <section aria-label="Product preview" className="pb-16">
          <p className="mono-label mb-3">Preview · sample trace rendered with the real explorer</p>
          <TraceExplorer trace={preview.trace} spans={preview.spans} projectId="preview" preview />
        </section>

        <section className="grid gap-10 border-t border-line py-16 md:grid-cols-3">
          {POINTS.map((p, i) => (
            <div key={p.title}>
              <span className="font-display text-4xl text-ember-2">0{i + 1}</span>
              <h2 className="mt-3 text-lg font-semibold text-ink">{p.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{p.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-6 sm:px-6">
          <Brand size={18} />
          <span className="font-mono text-[11px] text-ink-3">
            MIT licensed · Next.js on Vercel · Firebase Auth + Firestore
          </span>
        </div>
      </footer>
    </div>
  );
}
