import Link from "next/link";
import { STATUSES } from "@/lib/firetrace/schema";
import type { TraceFilters as Filters } from "@/lib/firetrace/types";

function toLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  // datetime-local wants no timezone; keep UTC wall time for determinism.
  return iso.slice(0, 16);
}

/** Plain GET form: filter state lives in the URL, so views can be bookmarked. */
export function TraceFilters({
  projectId,
  filters,
  models,
}: {
  projectId: string;
  filters: Filters;
  models: string[];
}) {
  const active = Object.values(filters).some(Boolean);
  return (
    <form
      method="get"
      action={`/projects/${projectId}`}
      className="card flex flex-wrap items-end gap-3 p-4"
    >
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
        <span className="mono-label block">Model</span>
        <input
          name="model"
          list={`models-${projectId}`}
          defaultValue={filters.model ?? ""}
          className="input mt-1.5"
          placeholder="any"
        />
        <datalist id={`models-${projectId}`}>
          {models.map((m) => (
            <option key={m} value={m} />
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
          <Link href={`/projects/${projectId}`} className="btn btn-ghost">
            Clear
          </Link>
        )}
      </div>
    </form>
  );
}
