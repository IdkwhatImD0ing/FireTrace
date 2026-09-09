import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { CardGrid, DocCard } from "@/components/docs/Cards";
import { CodeGroup } from "@/components/docs/CodeGroup";
import { Disclosure } from "@/components/docs/Disclosure";
import { CopyButton } from "@/components/ui/CopyButton";
import { getOwner } from "@/lib/auth/session";
import { loadDoc } from "@/lib/docs/load";
import { publicRepositoryUrl, trialTraceLimitFromEnv } from "@/lib/env/server";
import {
  INGEST_RESPONSE,
  LIST_RESPONSE,
  SCORE_RESPONSE,
  mcpSamples,
  readSamples,
  recordSamples,
  scoreSamples,
  spanSamples,
} from "./samples";

export const metadata: Metadata = {
  title: "Introduction",
  description:
    "Record every LLM and agent run as one trace, keep it as long as you like in a Firebase project you own, and read it back from your agents over MCP.",
};

/**
 * The deployment prompt lives in docs/deploy-prompt.md; this page offers the
 * same text. The file is a build-time constant, so it is read and parsed once
 * per process rather than on every request to this dynamically rendered page.
 */
let prompt: string | null | undefined;
function deployPrompt(): string | null {
  if (prompt !== undefined) return prompt;
  const block = loadDoc("deploy-prompt")?.blocks.find(
    (b) => b.type === "code" && b.lang === "text",
  );
  return (prompt = block?.type === "code" ? block.text : null);
}

/**
 * Origin for the copy-paste commands. NEXT_PUBLIC_APP_URL is the canonical
 * answer, but a deployment that forgot to set it would otherwise hand every
 * visitor commands pointing at localhost, so fall back to the request's host.
 */
async function deploymentOrigin(): Promise<string> {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  if (URL.canParse(configured)) return new URL(configured).origin;
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  return host ? `${requestHeaders.get("x-forwarded-proto") ?? "https"}://${host}` : "";
}

const SECTIONS = [
  { id: "get-started", text: "Get started" },
  { id: "other-ways-to-get-started", text: "Other ways to get started" },
  { id: "what-can-firetrace-do", text: "What can FireTrace do?" },
  { id: "why-firetrace", text: "Why FireTrace?" },
  { id: "record", text: "Record" },
  { id: "read", text: "Read" },
  { id: "judge", text: "Judge" },
  { id: "more-capabilities", text: "More capabilities" },
  { id: "resources", text: "Resources" },
];

export default async function DocsIntroductionPage() {
  const repoUrl = publicRepositoryUrl();
  const appUrl = await deploymentOrigin();
  const trialLimit = trialTraceLimitFromEnv();
  const owner = await getOwner();
  const setupPrompt = deployPrompt();

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_220px] xl:gap-10">
      <div className="doc-prose min-w-0">
        <header className="border-b border-line pb-6">
          <p className="mono-label">Get started</p>
          <h1 className="mt-2 mb-0 font-display text-5xl leading-none text-ink">Introduction</h1>
          <p className="mt-3 text-lg">
            Record every LLM and agent run as one trace, keep it as long as you like in a Firebase
            project you own, and read it back from your agents over MCP.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {setupPrompt && <CopyButton text={setupPrompt} label="Copy deployment prompt" />}
            <a
              href={`${repoUrl}#deploy-your-own`}
              className="btn btn-ghost btn-sm"
              target="_blank"
              rel="noreferrer"
            >
              Deploy your own
            </a>
            {owner ? (
              <Link href="/projects" className="btn btn-ghost btn-sm">
                Your projects
              </Link>
            ) : (
              <Link href="/login" className="btn btn-ghost btn-sm">
                Sign in
              </Link>
            )}
          </div>
        </header>

        <h2 id="get-started" className="scroll-mt-24">
          Get started
        </h2>
        <p>
          Everything below talks to <strong>this</strong> deployment at <code>{appUrl}</code>. All
          of it authenticates with one project API key (
          <code>ft_live_&lt;keyId&gt;_&lt;secret&gt;</code>), created in the dashboard under{" "}
          <strong>Project settings → API keys</strong> and shown exactly once. There is no keyless
          mode: FireTrace stores your traces in your own database, so it never accepts anonymous
          writes.
        </p>

        <h3 id="connect-an-agent" className="scroll-mt-24">
          Connect an agent over MCP
        </h3>
        <p>
          The fastest way in. Point any Model Context Protocol client at{" "}
          <code>{appUrl}/api/mcp</code> and your agent can list traces, walk span trees, record its
          own runs and leave scores. Tools are registered per key scope, so a read-only key never
          exposes a write tool.
        </p>
        <CodeGroup label="MCP client setup" samples={mcpSamples(appUrl)} />
        <p>
          Give an investigating agent a <strong>read-only</strong> key with an expiry, then ask it
          something like{" "}
          <em>&ldquo;list the last 10 error traces and tell me what broke.&rdquo;</em> Full tool
          reference in <Link href="/docs/mcp">MCP</Link>.
        </p>

        <h3 id="send-your-first-trace" className="scroll-mt-24">
          Send your first trace
        </h3>
        <p>
          One request stores one complete trace with all of its spans. No streaming, no batching, no
          agent to install. Any language that can POST JSON is a supported client.
        </p>
        <CodeGroup label="Send a trace" samples={recordSamples(appUrl)} />
        <Disclosure summary="Response · trace stored">
          <CodeGroup label="Ingest response" samples={INGEST_RESPONSE} />
        </Disclosure>
        <p>
          The trace is then visible at{" "}
          <code>
            /projects/{"{projectId}"}/traces/{"{traceId}"}
          </code>
          . Sending the same body again is a <code>200</code> with{" "}
          <code>&quot;duplicate&quot;: true</code> rather than a second trace, so retrying after a
          timeout is safe. See the <Link href="/docs/ingestion-api">ingestion API</Link> for the
          full field list, limits and error codes.
        </p>

        <h2 id="other-ways-to-get-started" className="scroll-mt-24">
          Other ways to get started
        </h2>
        <CardGrid>
          <DocCard href="/docs/deploy-prompt" title="Deploy with an AI agent" eyebrow="Fastest">
            Paste one prompt into your coding agent. It creates the Firebase project, sets the
            environment variables, deploys to Vercel and sends a smoke-test trace.
          </DocCard>
          <DocCard
            href="/docs/firebase-setup"
            title="Set up Firebase by hand"
            eyebrow="Step by step"
          >
            Create the project and database, enable sign-in providers, and mint the Admin credential
            the server uses.
          </DocCard>
          <DocCard href="/docs/vercel-deployment" title="Deploy to Vercel" eyebrow="Step by step">
            Import the repository, set the environment variables, authorize the domain, and run the
            smoke test.
          </DocCard>
          {trialLimit > 0 && !owner ? (
            <DocCard href="/login" title="Try it on this deployment" eyebrow="No deploy">
              Sign in with any verified Google or email account and record up to {trialLimit} traces
              against this instance before you deploy your own.
            </DocCard>
          ) : (
            <DocCard href={repoUrl} title="Read the source" eyebrow="MIT licensed">
              Next.js on Vercel, Firestore and Firebase Auth. Nothing runs that you cannot read.
            </DocCard>
          )}
        </CardGrid>

        <h2 id="what-can-firetrace-do" className="scroll-mt-24">
          What can FireTrace do?
        </h2>
        <CardGrid columns={3}>
          <DocCard href="/docs/ingestion-api" title="Record">
            One POST stores a run as a tree of spans with inputs, outputs, tokens, cost, errors and
            tags.
          </DocCard>
          <DocCard href="/docs/api" title="Read">
            Filter and page through traces from the dashboard, the REST API or an agent; open one as
            a span tree, waterfall and inspector.
          </DocCard>
          <DocCard href="/docs/evaluators" title="Judge">
            Attach typed scores by hand, from an agent, or from an LLM-as-judge evaluator you
            define.
          </DocCard>
        </CardGrid>

        <h2 id="why-firetrace" className="scroll-mt-24">
          Why FireTrace?
        </h2>
        <ul>
          <li>
            <strong>Yours, not rented:</strong> the app runs on your Vercel account against a
            Firebase project you own. FireTrace has no servers of its own and no access to your
            data.
          </li>
          <li>
            <strong>No expiry, ever:</strong> there is no TTL field, no <code>expireAt</code>, no
            cleanup job and no age-based deletion. Only an explicit owner action deletes a trace.
            Capacity is bounded by your Firebase plan, not by a retention window.
          </li>
          <li>
            <strong>One POST per run:</strong> a complete trace with up to 200 nested spans in a
            single request, deduplicated by a hash of the normalized body.
          </li>
          <li>
            <strong>Agent-native:</strong> the same data is available over MCP, over a REST API
            described by an OpenAPI 3.1 document, and in the dashboard.
          </li>
          <li>
            <strong>Environments come from the key:</strong> the server stamps{" "}
            <code>production</code>, <code>preview</code> or whatever slug the key carries onto
            every trace, so your application never sends an environment field and cannot mislabel
            one.
          </li>
        </ul>

        <h2 id="record" className="scroll-mt-24">
          Record
        </h2>
        <p>
          <code>POST /api/v1/traces</code> with scope <code>traces:write</code>. Bodies are strict:
          an unknown key at any level is a <code>400 invalid_trace</code>, so a typo can never be
          silently dropped. Trace ids are 32 hex characters, span ids 16 — the OpenTelemetry widths.
          Beyond the quickstart above, a real run is a tree: up to 200 spans, each with a{" "}
          <code>parentSpanId</code>, its own timings, tokens and cost, and up to 50 events.
        </p>
        <p>
          There is no dedicated error field. A failing step sets{" "}
          <code>status: &quot;error&quot;</code> and records <code>error.type</code> and{" "}
          <code>error.message</code> in its <code>attributes</code>; the dashboard&apos;s Error tab
          reads them from there. Full rules in{" "}
          <Link href="/docs/ingestion-api">the ingestion API</Link>.
        </p>
        <CodeGroup label="Span trees and errors" samples={spanSamples()} />

        <h2 id="read" className="scroll-mt-24">
          Read
        </h2>
        <p>
          <code>GET /api/v1/traces</code> with scope <code>traces:read</code> returns a newest-first
          page with cursor pagination. Filters (<code>status</code>, <code>model</code>,{" "}
          <code>name</code>, <code>tag</code>, <code>environment</code>, <code>sessionId</code>,{" "}
          <code>userId</code>, <code>from</code>, <code>to</code>) combine with AND, and{" "}
          <code>sort</code> can be <code>newest</code>, <code>slowest</code> or{" "}
          <code>costliest</code>. The query string is strict too, so a misspelled filter is a{" "}
          <code>400</code> rather than an accidental unfiltered list.
        </p>
        <CodeGroup label="Read traces" samples={readSamples(appUrl)} />
        <Disclosure summary="Response · one trace from a page">
          <CodeGroup label="List response" samples={LIST_RESPONSE} />
        </Disclosure>

        <h2 id="judge" className="scroll-mt-24">
          Judge
        </h2>
        <p>
          A score is a typed judgement attached to a trace after the run: a thumbs rating, a
          reviewer&apos;s verdict, an evaluator&apos;s result. Scores are indexed and append-only,
          they show up on the trace page and in the trace list, and every trace carries the newest
          score per name. Configure the optional LLM judge and you can run an evaluator over one
          trace or over a filtered list — see{" "}
          <Link href="/docs/evaluators">scores and evaluators</Link>.
        </p>
        <CodeGroup label="Add a score" samples={scoreSamples(appUrl)} />
        <Disclosure summary="Response · score stored">
          <CodeGroup label="Score response" samples={SCORE_RESPONSE} />
        </Disclosure>

        <h2 id="more-capabilities" className="scroll-mt-24">
          More capabilities
        </h2>
        <CardGrid>
          <DocCard href="/docs/api#environments" title="Environments">
            Label a key <code>production</code>, <code>preview</code> or your own slug; the server
            stamps it on every trace and the dashboard filters by it.
          </DocCard>
          <DocCard href="/docs/api#api-keys-and-scopes" title="Scoped keys">
            <code>traces:write</code>, <code>traces:read</code> and <code>traces:delete</code>, with
            optional expiry and one-transaction rotation.
          </DocCard>
          <DocCard href="/docs/ingestion-api#updating-metadata" title="Metadata patch">
            <code>PATCH</code> merges free-form facts into a stored trace without touching its body
            hash, for judgements that only arrive later.
          </DocCard>
          <DocCard href="/docs/ingestion-api#idempotency" title="Idempotent ingest">
            The body hash is computed after normalization, so a retry that differs only in key order
            or timestamp notation is a duplicate, not a conflict.
          </DocCard>
          <DocCard href="/docs/mcp#tools" title="MCP tools">
            <code>list_traces</code>, <code>get_trace</code>, <code>find_spans</code>,{" "}
            <code>record_trace</code>, <code>add_score</code> and more, registered per key scope.
          </DocCard>
          <DocCard href="/docs/evaluators#run-an-evaluator" title="LLM-as-judge evaluators">
            Point FireTrace at any OpenAI-compatible endpoint, define a judge from a template, and
            run it over a trace or a filtered list.
          </DocCard>
          <DocCard href="/docs/security" title="Security model">
            Deny-all Firestore rules, Admin-SDK-only access, HMAC key digests, origin checks and a
            deployment checklist.
          </DocCard>
          <DocCard href="/docs/api#operational-notes" title="Operational notes">
            What each call costs in Firestore reads, what is cacheable, and how cold starts show up
            in latency.
          </DocCard>
        </CardGrid>

        <h2 id="resources" className="scroll-mt-24">
          Resources
        </h2>
        <CardGrid>
          <DocCard href="/docs/api" title="API reference">
            Every key-authenticated endpoint, with scopes, filters, responses and error codes.
          </DocCard>
          <DocCard href="/docs/ingestion-api" title="Ingestion API">
            The wire format in full: field rules, limits, normalization, idempotency, error
            conventions.
          </DocCard>
          <DocCard href={`${repoUrl}/tree/main/packages/sdk-js`} title="TypeScript SDK">
            <code>@firetrace/sdk</code> — no runtime dependencies, never throws into your
            application unless you ask it to.
          </DocCard>
          <DocCard href={repoUrl} title="Source on GitHub">
            The whole application, MIT licensed. Fork it, audit it, run it yourself.
          </DocCard>
        </CardGrid>
        <p>
          For AI agents: fetch <a href="/api/v1/openapi.json">/api/v1/openapi.json</a> for this
          deployment&apos;s machine-readable contract, browse <a href="/api/v1">/api/v1</a> for the
          endpoint index, or connect an MCP client to <code>POST /api/mcp</code> with a bearer key.
          Every page in these docs has a <strong>Copy page as Markdown</strong> button for pasting
          into a model.
        </p>
      </div>

      <aside
        className="hidden xl:sticky xl:top-20 xl:block xl:self-start"
        aria-label="On this page"
      >
        <p className="mono-label mb-2">On this page</p>
        <ul className="space-y-1 border-l border-line text-sm">
          {SECTIONS.map((section) => (
            <li key={section.id} className="pl-3">
              <a href={`#${section.id}`} className="block py-0.5 text-ink-2 hover:text-ink">
                {section.text}
              </a>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
