import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CardGrid, DocCard } from "@/components/docs/Cards";
import { CopyButton } from "@/components/ui/CopyButton";
import { loadDoc } from "@/lib/docs/load";
import { DOCS, findDoc } from "@/lib/docs/registry";
import { renderBlocks } from "@/lib/docs/render";

/** Every doc is known at build time; unknown slugs are 404s. */
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

export async function generateMetadata({ params }: PageProps<"/docs/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const entry = findDoc(slug);
  return entry ? { title: entry.title, description: entry.summary } : {};
}

export default async function DocPage({ params }: PageProps<"/docs/[slug]">) {
  const { slug } = await params;
  const doc = loadDoc(slug);
  if (!doc) notFound();

  const index = DOCS.findIndex((d) => d.slug === slug);
  const previous = index > 0 ? DOCS[index - 1] : null;
  const next = index < DOCS.length - 1 ? DOCS[index + 1] : null;

  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_220px] xl:gap-10">
      <div className="min-w-0">
        <header className="mb-8 max-w-3xl border-b border-line pb-6">
          <p className="mono-label">{doc.entry.group}</p>
          <h1 className="mt-2 font-display text-5xl leading-none text-ink">{doc.title}</h1>
          <p className="mt-3 text-lg text-ink-2">{doc.entry.summary}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <CopyButton text={doc.source} label="Copy page as Markdown" />
            <a
              href={doc.sourceUrl}
              className="btn btn-ghost btn-sm"
              target="_blank"
              rel="noreferrer"
            >
              View source
            </a>
          </div>
        </header>
        <article className="doc-prose">{renderBlocks(doc.blocks)}</article>
        <footer className="mt-12 border-t border-line pt-6">
          {(previous || next) && (
            <CardGrid>
              {previous && (
                <DocCard href={`/docs/${previous.slug}`} title={previous.title} eyebrow="Previous">
                  {previous.summary}
                </DocCard>
              )}
              {next && (
                <DocCard href={`/docs/${next.slug}`} title={next.title} eyebrow="Next">
                  {next.summary}
                </DocCard>
              )}
            </CardGrid>
          )}
          <p className="mt-6 text-sm text-ink-3">
            This page is rendered from{" "}
            <code className="font-mono text-ink-2">docs/{doc.entry.file}</code> in the repository.{" "}
            <a
              href={doc.sourceUrl}
              className="text-ink-2 underline hover:text-ink"
              target="_blank"
              rel="noreferrer"
            >
              Edit this page on GitHub
            </a>
          </p>
        </footer>
      </div>
      {doc.toc.length > 1 && (
        <aside
          className="hidden xl:sticky xl:top-20 xl:block xl:self-start"
          aria-label="On this page"
        >
          <p className="mono-label mb-2">On this page</p>
          <ul className="space-y-1 border-l border-line text-sm">
            {doc.toc.map((entry) => (
              <li key={entry.id} className={entry.level === 3 ? "pl-6" : "pl-3"}>
                <a href={`#${entry.id}`} className="block py-0.5 text-ink-2 hover:text-ink">
                  {entry.text}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
