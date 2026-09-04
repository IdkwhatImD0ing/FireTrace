import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
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
        <article className="doc-prose">
          <p className="mono-label mb-2">{doc.entry.group}</p>
          {renderBlocks(doc.blocks)}
        </article>
        <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-6 text-sm">
          <div className="flex gap-3">
            {previous && (
              <Link href={`/docs/${previous.slug}`} className="btn btn-ghost btn-sm">
                ← {previous.title}
              </Link>
            )}
            {next && (
              <Link href={`/docs/${next.slug}`} className="btn btn-ghost btn-sm">
                {next.title} →
              </Link>
            )}
          </div>
          <a
            href={doc.sourceUrl}
            className="text-ink-2 underline hover:text-ink"
            target="_blank"
            rel="noreferrer"
          >
            Edit this page on GitHub
          </a>
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
