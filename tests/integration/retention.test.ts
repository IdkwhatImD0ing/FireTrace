import "./env";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sampleTraceRequest } from "@/lib/firetrace/sample";
import {
  clearFirestore,
  createTestKey,
  createTestProject,
  postTrace,
  projectData,
  spanDocs,
  traceData,
} from "./helpers";

const repoRoot = join(__dirname, "..", "..");
const RETENTION_MARKER = /expireAt|expiresAt|\bttl\b|timeToLive/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|json|rules)$/.test(entry)) out.push(full);
  }
  return out;
}

function fieldNames(doc: Record<string, unknown>): string[] {
  const names: string[] = [];
  const visit = (value: unknown, prefix: string) => {
    if (value && typeof value === "object" && !Array.isArray(value) && !("toDate" in value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        names.push(prefix ? `${prefix}.${k}` : k);
        visit(v, prefix ? `${prefix}.${k}` : k);
      }
    }
  };
  visit(doc, "");
  return names;
}

describe("retention: no TTL field, policy or cleanup path exists", () => {
  const body = sampleTraceRequest();
  let projectId = "";

  beforeAll(async () => {
    await clearFirestore();
    const project = await createTestProject("retained");
    projectId = project.id;
    const key = await createTestKey(projectId);
    const res = await postTrace(body, key.plaintext);
    if (res.status !== 201) throw new Error(`seed failed: ${res.status}`);
  });

  it("stored trace, span and project documents carry no expiry field", async () => {
    const trace = await traceData(projectId, body.trace.id);
    expect(trace).not.toBeNull();
    expect(fieldNames(trace ?? {}).filter((f) => RETENTION_MARKER.test(f))).toEqual([]);

    const spans = await spanDocs(projectId, body.trace.id);
    expect(spans).toHaveLength(5);
    for (const span of spans) {
      expect(
        fieldNames(span.data).filter((f) => RETENTION_MARKER.test(f)),
        span.id,
      ).toEqual([]);
    }

    const project = await projectData(projectId);
    expect(fieldNames(project).filter((f) => RETENTION_MARKER.test(f))).toEqual([]);
  });

  it("firestore.indexes.json declares no TTL field override and indexes no expiry field", () => {
    const raw = readFileSync(join(repoRoot, "firestore.indexes.json"), "utf8");
    expect(raw).not.toMatch(/ttl/i);
    const parsed = JSON.parse(raw) as {
      indexes: Array<{ fields: Array<{ fieldPath: string }> }>;
      fieldOverrides: Array<Record<string, unknown>>;
    };
    for (const index of parsed.indexes) {
      for (const field of index.fields) expect(field.fieldPath).not.toMatch(RETENTION_MARKER);
    }
    for (const override of parsed.fieldOverrides) {
      expect(override).not.toHaveProperty("ttl");
      expect(String(override.fieldPath)).not.toMatch(RETENTION_MARKER);
    }
  });

  it("firebase.json and firestore.rules contain no TTL or scheduled cleanup configuration", () => {
    const firebaseJson = readFileSync(join(repoRoot, "firebase.json"), "utf8");
    expect(firebaseJson).not.toMatch(/ttl|schedule|cleanup|pubsub|functions/i);
    const rules = readFileSync(join(repoRoot, "firestore.rules"), "utf8");
    expect(rules).not.toMatch(RETENTION_MARKER);
  });

  it("no trace-data module, script or SDK source references an expiry field or TTL", () => {
    // API keys may carry a credential lifetime (docs/security.md); trace, span
    // and project data never expire. Only the modules that own key lifetime
    // may mention expiry, and they never touch trace documents.
    const KEY_LIFETIME_MODULES = new Set(
      [
        "src/lib/actions.ts",
        "src/lib/firetrace/api-auth.ts",
        "src/lib/firetrace/convert.ts",
        "src/lib/firetrace/projects.ts",
        "src/lib/firetrace/scopes.ts",
        "src/lib/firetrace/types.ts",
        "src/app/api/v1/key/route.ts",
        "packages/sdk-js/src/api.ts",
      ].map((rel) => join(repoRoot, ...rel.split("/"))),
    );
    const files = [
      ...walk(join(repoRoot, "src", "lib")),
      ...walk(join(repoRoot, "src", "app", "api")),
      ...walk(join(repoRoot, "scripts")),
      ...walk(join(repoRoot, "packages", "sdk-js", "src")),
    ];
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter(
      (f) => !KEY_LIFETIME_MODULES.has(f) && RETENTION_MARKER.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);

    // The write path for trace data is scanned above and must stay clean.
    for (const rel of ["schema.ts", "normalize.ts", "ingest.ts", "queries.ts", "tree.ts"]) {
      const src = readFileSync(join(repoRoot, "src", "lib", "firetrace", rel), "utf8");
      expect(src, rel).not.toMatch(RETENTION_MARKER);
    }
  });
});
