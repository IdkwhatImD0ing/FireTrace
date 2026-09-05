/** Helpers for pages and routes that read `searchParams` and rebuild hrefs from them. */

/** A query value as a single string: the first entry when the key was repeated. */
export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** A trimmed, length-capped query value, or undefined when absent or blank. */
export function trimmedParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
  max: number,
): string | undefined {
  const s = firstParam(params[key]);
  return s && s.trim() ? s.trim().slice(0, max) : undefined;
}

/** `base` followed by the truthy entries of `params` as a query string; `base` alone when none. */
export function withParams(base: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * A `from`/`to` filter value as an ISO instant, or undefined when it does not parse.
 * datetime-local values carry no zone; the UI labels them UTC, so treat them as UTC.
 */
export function parseUtcDateParam(v: string | undefined): string | undefined {
  const utc = v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v) ? `${v}Z` : v;
  return utc && !Number.isNaN(Date.parse(utc)) ? new Date(utc).toISOString() : undefined;
}
