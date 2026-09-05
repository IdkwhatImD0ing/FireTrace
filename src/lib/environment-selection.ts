import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import { cookies } from "next/headers";
import { cache } from "react";
import {
  ALL_ENVIRONMENTS,
  defaultEnvironmentSelection,
  ENVIRONMENT_COOKIE,
  environmentFilterOf,
  isEnvironmentSelection,
  sortEnvironments,
  UNASSIGNED_ENVIRONMENT,
} from "@/lib/firetrace/environment";
import { listApiKeys } from "@/lib/firetrace/projects";

/**
 * The dashboard's environment selector. The choice lives in a cookie the
 * selector sets from the browser, so it follows the viewer across every
 * project page and survives reloads; the URL never carries it. Without a
 * cookie the project defaults to `production` when one of its keys is
 * assigned there, otherwise to every environment.
 */

export interface EnvironmentView {
  /** `all`, `unassigned` or an environment slug: what the selector shows. */
  selection: string;
  /** The filter for lists and rollups; undefined for `all`. */
  filter: string | undefined;
  /** Environments any key of the project carries, production first. */
  options: string[];
}

/** Keys of the project, read once per request: the layout, the page and the selector all need them. */
export const listProjectApiKeys = cache((db: Firestore, projectId: string) =>
  listApiKeys(db, projectId),
);

export const getEnvironmentView = cache(
  async (db: Firestore, projectId: string): Promise<EnvironmentView> => {
    const [keys, jar] = await Promise.all([listProjectApiKeys(db, projectId), cookies()]);
    const environments = [
      ...new Set(keys.map((k) => k.environment).filter((e): e is string => e !== null)),
    ].sort(sortEnvironments);
    const cookie = jar.get(ENVIRONMENT_COOKIE)?.value;
    const selection = isEnvironmentSelection(cookie)
      ? cookie
      : defaultEnvironmentSelection(environments);
    // A selection made in another project stays selectable here even if no key uses it yet.
    const options =
      selection === ALL_ENVIRONMENTS ||
      selection === UNASSIGNED_ENVIRONMENT ||
      environments.includes(selection)
        ? environments
        : [...environments, selection].sort(sortEnvironments);
    return { selection, filter: environmentFilterOf(selection), options };
  },
);
