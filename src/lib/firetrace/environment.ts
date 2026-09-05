import { ApiError } from "./errors";

/**
 * Environments keep production, preview and local traffic apart. The
 * environment lives on the API key and is copied onto every trace the key
 * ingests, so a client cannot claim an environment it does not hold a key
 * for, and deleting or editing a key later never touches stored traces.
 *
 * A key without an environment stamps `null`; such traces show up as
 * "unassigned". Every key and trace that predates this feature is unassigned.
 */
export const ENVIRONMENT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** One-click suggestions in the key dialog; any other slug is fine too. */
export const ENVIRONMENT_PRESETS = ["production", "preview", "development"] as const;

/** Filter value that selects traces whose environment is null. */
export const UNASSIGNED_ENVIRONMENT = "unassigned";
/** Dashboard selection meaning "no environment filter". */
export const ALL_ENVIRONMENTS = "all";

/** Words a key may not use as an environment because the filters give them a meaning. */
const RESERVED = new Set<string>([UNASSIGNED_ENVIRONMENT, ALL_ENVIRONMENTS]);

export function isEnvironmentSlug(value: unknown): value is string {
  return typeof value === "string" && ENVIRONMENT_RE.test(value) && !RESERVED.has(value);
}

/**
 * Environment for a key from user input: blank means unassigned; anything
 * else must be a slug (case is folded, whitespace trimmed) and not a reserved word.
 */
export function normalizeEnvironment(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string") {
    throw new ApiError(400, "invalid_request", "environment must be a string or null.");
  }
  const slug = input.trim().toLowerCase();
  if (slug === "") return null;
  if (RESERVED.has(slug)) {
    throw new ApiError(
      400,
      "invalid_request",
      `"${slug}" is reserved; pick another environment name.`,
    );
  }
  if (!ENVIRONMENT_RE.test(slug)) {
    throw new ApiError(
      400,
      "invalid_request",
      "environment must be 1-32 characters: lowercase letters, digits, '_' and '-', starting with a letter or digit.",
    );
  }
  return slug;
}

/**
 * An `environment` filter value: a slug, or `unassigned` for traces without
 * one. Case is folded. Lenient mode drops an invalid value; strict mode throws.
 * `all` is not a filter: omit the parameter to get every environment.
 */
export function parseEnvironmentFilter(
  value: string | undefined,
  options: { strict?: boolean } = {},
): string | undefined {
  if (value === undefined) return undefined;
  const slug = value.trim().toLowerCase();
  if (slug === "") return undefined;
  if (slug === UNASSIGNED_ENVIRONMENT || isEnvironmentSlug(slug)) return slug;
  if (options.strict) {
    throw new ApiError(
      400,
      "invalid_request",
      `Invalid environment "${value}". Use an environment slug (lowercase letters, digits, '_' and '-') or "${UNASSIGNED_ENVIRONMENT}"; omit the parameter for every environment.`,
    );
  }
  return undefined;
}

/** The stored value a filter matches: `unassigned` selects `null`. */
export function storedEnvironment(filter: string): string | null {
  return filter === UNASSIGNED_ENVIRONMENT ? null : filter;
}

/** Environment as read from a key or trace document; anything malformed is unassigned. */
export function environmentFromDocument(value: unknown): string | null {
  return isEnvironmentSlug(value) ? value : null;
}

export function environmentLabel(environment: string | null): string {
  return environment ?? UNASSIGNED_ENVIRONMENT;
}

// ---------------------------------------------------------------------------
// Dashboard selection: `all`, `unassigned` or a slug, kept in a cookie the
// selector writes from the browser and every project page reads on the server.

export const ENVIRONMENT_COOKIE = "firetrace_env";

export function isEnvironmentSelection(value: unknown): value is string {
  return value === ALL_ENVIRONMENTS || value === UNASSIGNED_ENVIRONMENT || isEnvironmentSlug(value);
}

/** Production once a key is assigned to it, otherwise every environment. */
export function defaultEnvironmentSelection(environments: readonly string[]): string {
  return environments.includes("production") ? "production" : ALL_ENVIRONMENTS;
}

/** The list/rollup filter behind a selection; `all` means no filter. */
export function environmentFilterOf(selection: string): string | undefined {
  return selection === ALL_ENVIRONMENTS ? undefined : selection;
}

/** Presets in their usual order first, then everything else alphabetically. */
export function sortEnvironments(a: string, b: string): number {
  const presets = ENVIRONMENT_PRESETS as readonly string[];
  const ia = presets.indexOf(a);
  const ib = presets.indexOf(b);
  if (ia !== -1 || ib !== -1) {
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  }
  return a.localeCompare(b);
}
