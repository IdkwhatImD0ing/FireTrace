import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  hasScope,
  type ListTracesQuery,
  type TraceBackend,
  type TraceDetailLike,
} from "./backend.ts";

export interface FireTraceMcpOptions {
  /** Reported to clients during initialize. */
  version?: string;
  name?: string;
}

const TRACE_ID = z
  .string()
  .regex(/^[0-9a-fA-F]{32}$/, "traceId is 32 hex characters")
  .transform((s) => s.toLowerCase());

const STATUS = z.enum(["ok", "error", "unset"]);

const SCORE_NAME = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, '_' and '-' only, at most 64 characters");

function ms(n: number): string {
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(2)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}

/** Recursively cap string lengths so a tool result stays readable for a model. */
export function truncateDeep(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    return value.length > maxChars
      ? `${value.slice(0, maxChars)}…[+${value.length - maxChars} chars truncated]`
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, maxChars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, maxChars);
    return out;
  }
  return value;
}

function text(body: string, structured?: Record<string, unknown>): CallToolResult {
  return structured
    ? { content: [{ type: "text", text: body }], structuredContent: structured }
    : { content: [{ type: "text", text: body }] };
}

function failure(err: unknown): CallToolResult {
  const e = err as { status?: number; code?: string; message?: string };
  const code = typeof e?.code === "string" ? e.code : "error";
  const status = typeof e?.status === "number" ? ` (HTTP ${e.status})` : "";
  const message = e?.message ?? String(err);
  return { content: [{ type: "text", text: `${code}${status}: ${message}` }], isError: true };
}

function summarizeLine(t: {
  id: string;
  startedAt: string;
  status: string;
  durationMs: number;
  name: string;
  model?: string | null;
  spanCount: number;
  errorCount: number;
}): string {
  const model = t.model ? ` · ${t.model}` : "";
  return `${t.id}  ${t.startedAt}  ${t.status.padEnd(9)} ${ms(t.durationMs).padStart(8)}  ${t.name}${model}  (${t.spanCount} spans, ${t.errorCount} errors)`;
}

function spanOutline(detail: TraceDetailLike): string {
  const byParent = new Map<string | null, TraceDetailLike["spans"]>();
  for (const s of detail.spans) {
    const list = byParent.get(s.parentSpanId) ?? [];
    list.push(s);
    byParent.set(s.parentSpanId, list);
  }
  const ids = new Set(detail.spans.map((s) => s.id));
  const roots = detail.spans.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
  const lines: string[] = [];
  const walk = (span: TraceDetailLike["spans"][number], depth: number) => {
    const flag = span.status === "error" ? " ✗" : "";
    lines.push(
      `${"  ".repeat(depth)}- ${span.id} [${span.kind}] ${span.name} ${ms(span.durationMs)}${span.model ? ` · ${span.model}` : ""}${flag}`,
    );
    for (const child of byParent.get(span.id) ?? []) if (child !== span) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return lines.join("\n");
}

/**
 * Build an MCP server over a TraceBackend. Only tools the key's scopes allow
 * are registered, so an agent never sees a tool it cannot call.
 */
export function createFireTraceMcpServer(
  backend: TraceBackend,
  options: FireTraceMcpOptions = {},
): McpServer {
  const server = new McpServer(
    { name: options.name ?? "firetrace", version: options.version ?? "0.1.0" },
    {
      instructions: [
        "FireTrace stores completed LLM/agent traces (a trace is a tree of spans).",
        `This key belongs to project ${backend.projectId} with scopes: ${backend.scopes.join(", ") || "none"}.`,
        "Use list_traces to find traces, get_trace for the full span tree, find_spans to locate specific spans, and record_trace to store a new trace (call get_ingest_schema first if unsure of the shape). add_score attaches a judgement made after the run (a rating, a verdict, an eval result) as a queryable score; list_scores reads scores back. patch_trace_metadata merges free-form keys into a trace's metadata.",
        "A stored trace is immutable apart from its metadata and scores; deletion is explicit and permanent.",
      ].join(" "),
    },
  );

  const canRead = hasScope(backend, "traces:read");
  const canWrite = hasScope(backend, "traces:write");
  const canDelete = hasScope(backend, "traces:delete");

  if (canRead) {
    server.registerTool(
      "get_project",
      {
        title: "Get project",
        description:
          "Return the project this key belongs to: name, trace and span counts, estimated storage, and the last trace time.",
        inputSchema: {},
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async () => {
        try {
          const p = await backend.getProject();
          const summary = [
            `Project ${p.name} (${p.id})`,
            p.description ? p.description : null,
            `${p.traceCount} traces, ${p.spanCount} spans, ~${(p.estimatedBytes / 1_000_000).toFixed(2)} MB stored${p.storage ? ` (${p.storage.level}, limit ${(p.storage.limitBytes / 1_000_000).toFixed(0)} MB)` : ""}`,
            `Last trace: ${p.lastTraceAt ?? "never"}`,
            `Key scopes: ${backend.scopes.join(", ")}`,
          ]
            .filter(Boolean)
            .join("\n");
          return text(summary, p as unknown as Record<string, unknown>);
        } catch (err) {
          return failure(err);
        }
      },
    );

    server.registerTool(
      "list_traces",
      {
        title: "List traces",
        description:
          "List traces newest first (or slowest/costliest first) with optional filters (all combine with AND). Returns one line per trace plus a cursor for the next page. Times are ISO-8601 UTC.",
        inputSchema: {
          status: STATUS.optional().describe("Only traces with this status"),
          model: z.string().max(200).optional().describe("Exact model name, e.g. gpt-5"),
          name: z.string().max(500).optional().describe("Exact trace name"),
          tag: z.string().max(64).optional().describe("One tag the trace must carry"),
          sessionId: z.string().max(200).optional(),
          userId: z.string().max(200).optional(),
          sort: z
            .enum(["newest", "slowest", "costliest"])
            .optional()
            .describe(
              "Ordering; slowest and costliest combine only with status, model, name and tag",
            ),
          from: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe("Inclusive lower bound on startedAt"),
          to: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe("Inclusive upper bound on startedAt"),
          limit: z.number().int().min(1).max(200).optional().describe("Page size, default 20"),
          cursor: z.string().max(500).optional().describe("nextCursor from a previous call"),
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async (input) => {
        try {
          const query: ListTracesQuery = { ...input, limit: input.limit ?? 20 };
          const page = await backend.listTraces(query);
          const header =
            page.traces.length === 0
              ? "No traces match."
              : `${page.traces.length} trace(s), newest first. Columns: id, startedAt, status, duration, name · model, spans/errors.`;
          const lines = page.traces.map(summarizeLine);
          const footer = page.nextCursor
            ? `More available: call again with cursor="${page.nextCursor}".`
            : "End of results.";
          return text([header, ...lines, footer].join("\n"), {
            traces: page.traces.map((t) => ({
              id: t.id,
              name: t.name,
              status: t.status,
              startedAt: t.startedAt,
              durationMs: t.durationMs,
              model: t.model ?? null,
              sessionId: t.sessionId ?? null,
              userId: t.userId ?? null,
              spanCount: t.spanCount,
              errorCount: t.errorCount,
              costUsd: t.costUsd ?? null,
              usage: t.usage ?? null,
            })),
            nextCursor: page.nextCursor,
          });
        } catch (err) {
          return failure(err);
        }
      },
    );

    server.registerTool(
      "get_trace",
      {
        title: "Get trace",
        description:
          "Return one trace with its full span tree: an outline first, then the trace and spans as JSON. Long strings are truncated to maxChars (default 2000); pass a larger value or use find_spans + get_trace with a small maxSpans to focus.",
        inputSchema: {
          traceId: TRACE_ID,
          maxChars: z
            .number()
            .int()
            .min(50)
            .max(200_000)
            .optional()
            .describe("Per-string truncation, default 2000"),
          maxSpans: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("Cap on spans included in the JSON, default 100"),
          includeContent: z
            .boolean()
            .optional()
            .describe(
              "Include span input/output/attributes (default true). false returns timing and status only.",
            ),
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async (input) => {
        try {
          const detail = await backend.getTrace(input.traceId);
          if (!detail)
            return failure({
              status: 404,
              code: "not_found",
              message: `No trace ${input.traceId} in this project.`,
            });
          const maxSpans = input.maxSpans ?? 100;
          const include = input.includeContent ?? true;
          const spans = detail.spans.slice(0, maxSpans).map((s) =>
            include
              ? s
              : {
                  id: s.id,
                  parentSpanId: s.parentSpanId,
                  name: s.name,
                  kind: s.kind,
                  status: s.status,
                  startedAt: s.startedAt,
                  endedAt: s.endedAt,
                  durationMs: s.durationMs,
                  model: s.model ?? null,
                  usage: s.usage ?? null,
                },
          );
          const omitted = detail.spans.length - spans.length;
          const body = truncateDeep(
            {
              trace: detail.trace,
              spans,
              ...(detail.scores?.length ? { scores: detail.scores } : {}),
            },
            input.maxChars ?? 2000,
          );
          const outline = spanOutline(detail);
          const parts = [
            `Trace ${detail.trace.id} "${detail.trace.name}" — ${detail.trace.status}, ${ms(detail.trace.durationMs)}, ${detail.spans.length} spans, ${detail.trace.errorCount} errors, started ${detail.trace.startedAt}.`,
            "Span outline:",
            outline || "(no spans)",
            omitted > 0
              ? `JSON below includes the first ${spans.length} spans; ${omitted} omitted (raise maxSpans).`
              : "",
            JSON.stringify(body, null, 1),
          ].filter(Boolean);
          return text(parts.join("\n\n"));
        } catch (err) {
          return failure(err);
        }
      },
    );

    server.registerTool(
      "find_spans",
      {
        title: "Find spans",
        description:
          "Locate spans inside one trace by kind, status, or name substring without loading their content. Use before get_trace when a trace is large.",
        inputSchema: {
          traceId: TRACE_ID,
          kind: z
            .string()
            .max(40)
            .optional()
            .describe("llm, agent, tool, chain, retriever, embedding, reranker, custom"),
          status: STATUS.optional(),
          nameContains: z
            .string()
            .max(200)
            .optional()
            .describe("Case-insensitive substring of the span name"),
          limit: z.number().int().min(1).max(500).optional().describe("Default 50"),
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async (input) => {
        try {
          const detail = await backend.getTrace(input.traceId);
          if (!detail)
            return failure({
              status: 404,
              code: "not_found",
              message: `No trace ${input.traceId} in this project.`,
            });
          const needle = input.nameContains?.toLowerCase();
          const matches = detail.spans.filter(
            (s) =>
              (!input.kind || s.kind === input.kind) &&
              (!input.status || s.status === input.status) &&
              (!needle || s.name.toLowerCase().includes(needle)),
          );
          const shown = matches.slice(0, input.limit ?? 50);
          const lines = shown.map(
            (s) =>
              `${s.id}  parent=${s.parentSpanId ?? "-"}  [${s.kind}] ${s.status.padEnd(9)} ${ms(s.durationMs).padStart(8)}  ${s.name}${s.model ? ` · ${s.model}` : ""}`,
          );
          const header = `${matches.length} of ${detail.spans.length} spans match${shown.length < matches.length ? ` (showing ${shown.length})` : ""}.`;
          return text([header, ...lines].join("\n"), {
            spans: shown.map((s) => ({
              id: s.id,
              parentSpanId: s.parentSpanId,
              name: s.name,
              kind: s.kind,
              status: s.status,
              durationMs: s.durationMs,
              model: s.model ?? null,
            })),
            total: matches.length,
          });
        } catch (err) {
          return failure(err);
        }
      },
    );

    server.registerTool(
      "list_scores",
      {
        title: "List scores",
        description:
          "Scores are judgements attached to traces after the run (ratings, review verdicts, evaluator results): a name, a numeric/categorical/boolean value and an optional comment. Pass traceId for one trace's full history, or name to see one score across the project, newest first.",
        inputSchema: {
          traceId: TRACE_ID.optional().describe("Only this trace's scores"),
          name: SCORE_NAME.optional().describe("Only scores with this name"),
          limit: z.number().int().min(1).max(500).optional().describe("Page size, default 50"),
          cursor: z.string().max(500).optional().describe("nextCursor from a previous call"),
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async (input) => {
        try {
          const page = await backend.listScores({ ...input, limit: input.limit ?? 50 });
          const header =
            page.scores.length === 0
              ? "No scores match."
              : `${page.scores.length} score(s), newest first. Columns: id, createdAt, traceId, name=value, source, comment.`;
          const lines = page.scores.map((s) => {
            const comment = s.comment
              ? `  ${s.comment.length > 120 ? `${s.comment.slice(0, 120)}…` : s.comment}`
              : "";
            return `${s.id}  ${s.createdAt}  ${s.traceId}  ${s.name}=${JSON.stringify(s.value)}  ${s.source}${comment}`;
          });
          const footer = page.nextCursor
            ? `More available: call again with cursor="${page.nextCursor}".`
            : "End of results.";
          return text([header, ...lines, footer].join("\n"), {
            scores: page.scores,
            nextCursor: page.nextCursor,
          });
        } catch (err) {
          return failure(err);
        }
      },
    );
  }

  if (canWrite) {
    server.registerTool(
      "get_ingest_schema",
      {
        title: "Get ingest schema",
        description:
          "JSON Schema for the body accepted by record_trace ({ schemaVersion: 1, trace }). Consult it before recording a trace by hand.",
        inputSchema: {},
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      async () => {
        try {
          const schema = await backend.ingestSchema();
          return text(JSON.stringify(schema, null, 1));
        } catch (err) {
          return failure(err);
        }
      },
    );

    server.registerTool(
      "record_trace",
      {
        title: "Record trace",
        description:
          "Store one complete, immutable trace. `trace` must follow the ingestion schema: id (32 hex), name, status, startedAt/endedAt (ISO-8601), and spans[] each with id (16 hex), parentSpanId, name, kind, status, startedAt, endedAt. Resending an identical trace is a no-op; reusing an id with different content is rejected.",
        inputSchema: {
          trace: z.record(z.string(), z.unknown()).describe("The trace object (not the envelope)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (input) => {
        try {
          const result = await backend.recordTrace({ schemaVersion: 1, trace: input.trace });
          const verb = result.duplicate ? "Already stored (identical duplicate)" : "Stored";
          return text(`${verb}: trace ${result.traceId} with ${result.spanCount} spans.`, {
            ...result,
          });
        } catch (err) {
          return failure(err);
        }
      },
    );

    server.registerTool(
      "add_score",
      {
        title: "Add score",
        description:
          "Attach a score to a stored trace: a judgement made after the run, such as a rating, a review verdict or an evaluator's result. Scores are indexed and listable (unlike metadata). Each has a name (letters, digits, '_' and '-'), a dataType with a matching value (numeric → number, categorical → string, boolean → boolean) and an optional comment explaining it. Scores are append-only: adding the same name again records a newer score, and the trace's summary shows the newest per name.",
        inputSchema: {
          traceId: TRACE_ID,
          name: SCORE_NAME.describe("Score name, e.g. accuracy, helpful, topic"),
          dataType: z.enum(["numeric", "categorical", "boolean"]),
          value: z
            .union([z.number(), z.string().max(200), z.boolean()])
            .describe("Must match dataType"),
          comment: z.string().max(2000).optional().describe("Why this score was given"),
          spanId: z
            .string()
            .regex(/^[0-9a-fA-F]{16}$/)
            .optional()
            .describe("Scope the score to one span instead of the whole trace"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (input) => {
        try {
          const { traceId, ...score } = input;
          const stored = await backend.addScore(traceId, score);
          return text(
            `Added score ${stored.name}=${JSON.stringify(stored.value)} (${stored.id}) to trace ${traceId}.`,
            { ...stored },
          );
        } catch (err) {
          return failure(err);
        }
      },
    );

    server.registerTool(
      "patch_trace_metadata",
      {
        title: "Patch trace metadata",
        description:
          "Shallow-merge keys into a stored trace's metadata for free-form facts that only exist after the run (a business outcome, a link to a ticket). For ratings, verdicts and eval results prefer add_score, which is indexed. A key in the patch replaces that top-level key outright; keys not mentioned are left alone; concurrent writers on one key are last-writer-wins. Everything else about the trace, spans included, stays immutable. Metadata is not indexed, so it cannot be searched or filtered by.",
        inputSchema: {
          traceId: TRACE_ID,
          metadata: z
            .record(z.string(), z.unknown())
            .describe("Keys to merge into the trace's existing metadata"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (input) => {
        try {
          const result = await backend.patchTraceMetadata(input.traceId, input.metadata);
          const verb = result.changed ? "Merged into" : "Already matched";
          return text(
            `${verb} the metadata of trace ${input.traceId}; it now has ${Object.keys(result.metadata).length} keys.`,
            { ...result },
          );
        } catch (err) {
          return failure(err);
        }
      },
    );
  }

  if (canDelete) {
    server.registerTool(
      "delete_trace",
      {
        title: "Delete trace",
        description:
          "Permanently delete one trace and all of its spans. Irreversible. Requires confirm=true.",
        inputSchema: {
          traceId: TRACE_ID,
          confirm: z.literal(true).describe("Must be true; guards against accidental deletion"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async (input) => {
        try {
          await backend.deleteTrace(input.traceId);
          return text(`Deleted trace ${input.traceId}.`, { ok: true, traceId: input.traceId });
        } catch (err) {
          return failure(err);
        }
      },
    );
  }

  return server;
}
