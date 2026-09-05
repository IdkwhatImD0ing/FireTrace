import Link from "next/link";
import { STATUSES } from "@/lib/firetrace/schema";
import type { TraceFacets, TraceFilters as Filters, TraceSort } from "@/lib/firetrace/types";
import { withParams } from "@/lib/search-params";

function toLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  // datetime-local wants no timezone; keep UTC wall time for determinism.
  return iso.slice(0, 16);
}

/** Plain GET form: filter state lives in the URL, so views can be bookmarked. */
export function TraceFilters({
  projectId,
  filters,
  facets,
  sort,
}: {
  projectId: string;
  filters: Filters;
  facets: TraceFacets;
  sort: TraceSort;
}) {
  const base = `/projects/${projectId}`;
  const active = Object.values(filters).some(Boolean) || sort !== "newest";
  // Slowest/costliest only combine with these four; the presets drop the rest.
  const compatible = {
    status: filters.status,
    model: filters.model,
    name: filters.name,
    tag: filters.tag,
  };
  const presets = [
    { label: "Newest", to: withParams(base, { ...filters }), active: sort === "newest" },
    {
      label: "Slowest",
      to: withParams(base, { ...compatible, sort: "slowest" }),
      active: sort === "slowest",
    },
    {
      label: "Costliest",
      to: withParams(base, { ...compatible, sort: "costliest" }),
      active: sort === "costliest",
    },
    {
      label: "Errors only",
      to: withParams(base, {
        ...(sort === "newest" ? filters : compatible),
        status: "error",
        sort: sort === "newest" ? undefined : sort,
      }),
      active: filters.status === "error",
    },
  ];
  const ids = (suffix: string) => `${suffix}-${projectId}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Presets">
        <span className="mono-label mr-1">Show</span>
        {presets.map((p) => (
          <Link
            key={p.label}
            href={p.to}
            aria-current={p.active ? "page" : undefined}
            className={`btn btn-sm ${p.active ? "btn-primary" : "btn-ghost"}`}
          >
            {p.label}
          </Link>
        ))}
      </div>
      <form method="get" action={base} className="card flex flex-wrap items-end gap-3 p-4">
        {sort !== "newest" && <input type="hidden" name="sort" value={sort} />}
        <label className="min-w-32">
          <span className="mono-label block">Status</span>
          <select name="status" defaultValue={filters.status ?? ""} className="input mt-1.5">
            <option value="">any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-40">
          <span className="mono-label block">Trace name</span>
          <input
            name="name"
            list={ids("names")}
            defaultValue={filters.name ?? ""}
            className="input mt-1.5"
            placeholder="any (exact)"
          />
          <datalist id={ids("names")}>
            {facets.names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </label>
        <label className="min-w-40">
          <span className="mono-label block">Model</span>
          <input
            name="model"
            list={ids("models")}
            defaultValue={filters.model ?? ""}
            className="input mt-1.5"
            placeholder="any"
          />
          <datalist id={ids("models")}>
            {facets.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="min-w-32">
          <span className="mono-label block">Tag</span>
          <input
            name="tag"
            list={ids("tags")}
            defaultValue={filters.tag ?? ""}
            className="input mt-1.5"
            placeholder="any"
          />
          <datalist id={ids("tags")}>
            {facets.tags.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="min-w-40">
          <span className="mono-label block">Session ID</span>
          <input
            name="sessionId"
            defaultValue={filters.sessionId ?? ""}
            className="input mt-1.5"
            placeholder="any"
          />
        </label>
        <label className="min-w-40">
          <span className="mono-label block">User ID</span>
          <input
            name="userId"
            defaultValue={filters.userId ?? ""}
            className="input mt-1.5"
            placeholder="any"
          />
        </label>
        <label>
          <span className="mono-label block">From (UTC)</span>
          <input
            type="datetime-local"
            name="from"
            defaultValue={toLocalInput(filters.from)}
            className="input mt-1.5"
          />
        </label>
        <label>
          <span className="mono-label block">To (UTC)</span>
          <input
            type="datetime-local"
            name="to"
            defaultValue={toLocalInput(filters.to)}
            className="input mt-1.5"
          />
        </label>
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary">
            Apply
          </button>
          {active && (
            <Link href={base} className="btn btn-ghost">
              Clear
            </Link>
          )}
        </div>
      </form>
    </div>
  );
}
