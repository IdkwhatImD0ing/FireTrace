import Link from "next/link";
import { DEFAULT_REPOSITORY_URL } from "@/lib/env/server";
import { DOC_GROUPS, DOCS } from "@/lib/docs/registry";

export const dynamic = "force-static";

export default function DocsIndexPage() {
  const repoUrl = (process.env.NEXT_PUBLIC_REPOSITORY_URL || DEFAULT_REPOSITORY_URL).replace(
    /\/+$/,
    "",
  );
  return (
    <div className="space-y-10">
      <div>
        <p className="mono-label">Documentation</p>
        <h1 className="mt-1 font-display text-5xl leading-none text-ink">
          Run FireTrace, send traces, <em className="text-ember-2">let agents read them.</em>
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-ink-2">
          These pages are rendered from the Markdown files in the repository&apos;s{" "}
          <code className="font-mono text-ink">docs/</code> folder, so they always match the code
          this deployment runs. The{" "}
          <a href={`${repoUrl}#readme`} className="underline" target="_blank" rel="noreferrer">
            README
          </a>{" "}
          covers what FireTrace is and the local quickstart.
        </p>
      </div>

      {DOC_GROUPS.map((group) => (
        <section key={group} aria-labelledby={`group-${group.replace(/\s+/g, "-")}`}>
          <h2 id={`group-${group.replace(/\s+/g, "-")}`} className="mono-label mb-3">
            {group}
          </h2>
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {DOCS.filter((d) => d.group === group).map((doc) => (
              <li key={doc.slug} className="card flex flex-col p-5">
                <Link
                  href={`/docs/${doc.slug}`}
                  className="font-display text-2xl text-ink hover:underline"
                >
                  {doc.title}
                </Link>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{doc.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="card p-5" aria-labelledby="quick-links">
        <h2 id="quick-links" className="mono-label mb-3">
          Machine-readable
        </h2>
        <ul className="space-y-1 text-sm text-ink-2">
          <li>
            <a href="/api/v1/openapi.json" className="underline">
              /api/v1/openapi.json
            </a>{" "}
            · OpenAPI 3.1 document for this deployment
          </li>
          <li>
            <a href="/api/v1" className="underline">
              /api/v1
            </a>{" "}
            · endpoint index
          </li>
          <li>
            <code className="font-mono text-ink">POST /api/mcp</code> · Model Context Protocol
            endpoint (bearer key)
          </li>
        </ul>
      </section>
    </div>
  );
}
