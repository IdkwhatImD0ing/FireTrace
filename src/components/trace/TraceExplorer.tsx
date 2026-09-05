"use client";

import { useMemo, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { StatusBadge, StatusIcon } from "@/components/StatusBadge";
import { CopyButton } from "@/components/ui/CopyButton";
import { JsonView } from "@/components/ui/JsonView";
import { MessageList } from "./MessageList";
import { Tabs, type TabItem } from "@/components/ui/Tabs";
import { KIND_COLOR } from "@/lib/firetrace/kinds";
import { SPAN_KINDS, type SpanKind } from "@/lib/firetrace/schema";
import { buildSpanTree, descendantCount, visibleRows } from "@/lib/firetrace/tree";
import type { SpanDetail, TraceDetail } from "@/lib/firetrace/types";
import { formatBytes } from "@/lib/firetrace/storage";
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatOffset,
  formatTokens,
  totalTokens,
} from "@/lib/format";

type Selection = { kind: "trace" } | { kind: "span"; id: string };

const TICKS = [0, 0.25, 0.5, 0.75, 1];

function labelStyle(left: number, width: number): { style: CSSProperties; plate: boolean } {
  if (left + width <= 82) return { style: { left: `calc(${left + width}% + 8px)` }, plate: false };
  if (left >= 18) return { style: { right: `calc(${100 - left}% + 8px)` }, plate: false };
  return { style: { right: `calc(${100 - left - width}% + 4px)` }, plate: true };
}

function Fact({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mono-label">{label}</div>
      <div className={`mt-0.5 truncate text-sm text-ink ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function IdFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="mono-label">{label}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="truncate font-mono text-xs text-ink" title={value}>
          {value}
        </span>
        <CopyButton text={value} label="Copy" className="btn btn-ghost btn-sm shrink-0" />
      </div>
    </div>
  );
}

function usageFacts(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null,
) {
  if (!usage) return null;
  const parts = [
    usage.inputTokens !== undefined ? `${formatTokens(usage.inputTokens)} in` : null,
    usage.outputTokens !== undefined ? `${formatTokens(usage.outputTokens)} out` : null,
    usage.totalTokens !== undefined ? `${formatTokens(usage.totalTokens)} total` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function errorDetails(span: SpanDetail): {
  message: string | null;
  type: string | null;
  stack: string | null;
} {
  const a = span.attributes;
  const pick = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : null);
  return {
    message: pick("error.message") ?? pick("exception.message"),
    type: pick("error.type") ?? pick("error.name") ?? pick("exception.type"),
    stack: pick("error.stack") ?? pick("exception.stacktrace"),
  };
}

export function TraceExplorer({
  trace,
  spans,
  projectId,
  preview = false,
  scoresTab,
}: {
  trace: TraceDetail;
  spans: SpanDetail[];
  projectId: string;
  preview?: boolean;
  /** Rendered as a "Scores" inspector tab on the trace page; absent in the landing preview. */
  scoresTab?: Pick<TabItem, "badge" | "content">;
}) {
  const tree = useMemo(
    () =>
      buildSpanTree(
        spans,
        (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id),
      ),
    [spans],
  );
  const allRows = tree.rows;
  const [selection, setSelection] = useState<Selection>({ kind: "trace" });
  const [tab, setTab] = useState("overview");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const rows = useMemo(() => visibleRows(allRows, collapsed, query), [allRows, collapsed, query]);
  const searching = query.trim().length > 0;

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function collapseAll() {
    setCollapsed(new Set(allRows.filter((r) => r.children.length > 0).map((r) => r.span.id)));
  }

  const t0 = Math.min(Date.parse(trace.startedAt), ...spans.map((s) => Date.parse(s.startedAt)));
  const t1 = Math.max(Date.parse(trace.endedAt), ...spans.map((s) => Date.parse(s.endedAt)));
  const total = Math.max(1, t1 - t0);
  const selectedSpan =
    selection.kind === "span" ? (spans.find((s) => s.id === selection.id) ?? null) : null;
  const kindsPresent = SPAN_KINDS.filter((k) => spans.some((s) => s.kind === k));

  function select(next: Selection) {
    setSelection(next);
    setTab("overview");
  }

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && selection.kind === "span") {
      const node = allRows.find((r) => r.span.id === selection.id);
      if (node && node.children.length > 0 && !searching) {
        e.preventDefault();
        const isCollapsed = collapsed.has(selection.id);
        if (e.key === "ArrowLeft" && !isCollapsed) toggle(selection.id);
        if (e.key === "ArrowRight" && isCollapsed) toggle(selection.id);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const order: Selection[] = [
      { kind: "trace" },
      ...rows.map((r) => ({ kind: "span", id: r.span.id }) as Selection),
    ];
    const current = order.findIndex((s) =>
      s.kind === "trace"
        ? selection.kind === "trace"
        : selection.kind === "span" && selection.id === s.id,
    );
    let next = current;
    if (e.key === "ArrowDown") next = Math.min(order.length - 1, current + 1);
    if (e.key === "ArrowUp") next = Math.max(0, current - 1);
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = order.length - 1;
    select(order[next]);
    const target = e.currentTarget.querySelector<HTMLButtonElement>(`[data-row="${next}"]`);
    target?.focus();
  }

  const traceTabs: TabItem[] = [
    {
      id: "overview",
      label: "Overview",
      content: (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Fact label="status" value={<StatusBadge status={trace.status} />} mono={false} />
          <Fact label="duration" value={formatDuration(trace.durationMs)} />
          <Fact label="started" value={formatDateTime(trace.startedAt)} />
          <Fact label="ended" value={formatDateTime(trace.endedAt)} />
          <Fact
            label="provider / model"
            value={[trace.provider, trace.model].filter(Boolean).join(" / ") || "—"}
          />
          <Fact label="tokens" value={usageFacts(trace.usage) ?? "—"} />
          <Fact label="cost" value={formatCost(trace.costUsd)} />
          <Fact label="spans" value={`${trace.spanCount} · ${trace.errorCount} with errors`} />
          <Fact label="session" value={trace.sessionId ?? "—"} />
          <Fact label="user" value={trace.userId ?? "—"} />
          <Fact label="est. size" value={formatBytes(trace.estimatedBytes)} />
          <Fact label="ingested" value={formatDateTime(trace.ingestedAt)} />
          <div className="col-span-2">
            <IdFact label="trace id" value={trace.id} />
          </div>
          <div className="col-span-2">
            <Fact label="body hash (sha-256)" value={trace.bodyHash || "—"} />
          </div>
          {trace.tags.length > 0 && (
            <div className="col-span-2">
              <div className="mono-label">tags</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {trace.tags.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ),
    },
    { id: "input", label: "Input", content: <MessageList value={trace.input} /> },
    { id: "output", label: "Output", content: <MessageList value={trace.output} /> },
    {
      id: "metadata",
      label: "Metadata",
      badge: Object.keys(trace.metadata).length || undefined,
      content: (
        <JsonView
          value={Object.keys(trace.metadata).length ? trace.metadata : null}
          emptyLabel="No metadata"
        />
      ),
    },
    ...(scoresTab ? [{ id: "scores", label: "Scores", ...scoresTab }] : []),
  ];

  const spanTabs = (span: SpanDetail): TabItem[] => {
    const err = errorDetails(span);
    const node = allRows.find((r) => r.span.id === span.id);
    return [
      {
        id: "overview",
        label: "Overview",
        content: (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Fact label="status" value={<StatusBadge status={span.status} />} mono={false} />
            <Fact
              label="kind"
              value={
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: KIND_COLOR[span.kind] }}
                    aria-hidden
                  />
                  {span.kind}
                </span>
              }
            />
            <Fact label="duration" value={formatDuration(span.durationMs)} />
            <Fact label="start offset" value={formatOffset(Date.parse(span.startedAt) - t0)} />
            <Fact label="started" value={formatDateTime(span.startedAt)} />
            <Fact label="ended" value={formatDateTime(span.endedAt)} />
            <Fact
              label="provider / model"
              value={[span.provider, span.model].filter(Boolean).join(" / ") || "—"}
            />
            <Fact label="tokens" value={usageFacts(span.usage) ?? "—"} />
            <Fact label="cost" value={formatCost(span.costUsd)} />
            <Fact label="events" value={String(span.events.length)} />
            <div className="col-span-2">
              <IdFact label="span id" value={span.id} />
            </div>
            <div className="col-span-2">
              {span.parentSpanId ? (
                <IdFact
                  label={node?.orphan ? "parent span id (missing from trace)" : "parent span id"}
                  value={span.parentSpanId}
                />
              ) : (
                <Fact label="parent" value="root span" />
              )}
            </div>
          </div>
        ),
      },
      { id: "input", label: "Input", content: <MessageList value={span.input} /> },
      { id: "output", label: "Output", content: <MessageList value={span.output} /> },
      {
        id: "attributes",
        label: "Attributes",
        badge: Object.keys(span.attributes).length || undefined,
        content:
          Object.keys(span.attributes).length === 0 ? (
            <p className="text-sm text-ink-3">No attributes</p>
          ) : (
            <dl className="grid grid-cols-[minmax(0,12rem)_1fr] gap-x-4 gap-y-1.5 font-mono text-xs">
              {Object.entries(span.attributes).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="truncate text-ink-3" title={k}>
                    {k}
                  </dt>
                  <dd className="break-all text-ink-2">
                    {typeof v === "string" ? v : JSON.stringify(v)}
                  </dd>
                </div>
              ))}
            </dl>
          ),
      },
      {
        id: "events",
        label: "Events",
        badge: span.events.length || undefined,
        content:
          span.events.length === 0 ? (
            <p className="text-sm text-ink-3">No events</p>
          ) : (
            <ol className="space-y-2">
              {span.events.map((ev, i) => (
                <li key={i} className="rounded-md border border-line bg-bg-2 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink">{ev.name}</span>
                    <span className="font-mono text-[11px] text-ink-3">
                      {formatOffset(Date.parse(ev.timestamp) - Date.parse(span.startedAt))}
                    </span>
                  </div>
                  {ev.attributes && Object.keys(ev.attributes).length > 0 && (
                    <pre className="mt-2 font-mono text-[11px] break-words whitespace-pre-wrap text-ink-2">
                      {JSON.stringify(ev.attributes, null, 2)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          ),
      },
      {
        id: "error",
        label: "Error",
        badge: span.status === "error" ? "!" : undefined,
        content:
          span.status !== "error" && !err.message ? (
            <p className="text-sm text-ink-3">No error recorded.</p>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">
                {err.message
                  ? "The span reported an error."
                  : "The span ended with status error but attached no error details."}
              </p>
              {err.type && <Fact label="type" value={err.type} />}
              {err.message && (
                <pre className="pre border-crit/40 bg-crit/10 text-crit-2">{err.message}</pre>
              )}
              {err.stack && <pre className="pre max-h-72 overflow-auto">{err.stack}</pre>}
            </div>
          ),
      },
    ];
  };

  return (
    <div
      className={`grid items-start gap-5 ${preview ? "" : "xl:grid-cols-[minmax(0,1fr)_26rem]"}`}
    >
      <div className="card [--name-col:220px] md:[--name-col:320px]">
        <div className="grid grid-cols-[var(--name-col)_1fr] border-b border-line">
          <div className="flex items-center gap-2 px-3 py-1.5">
            {preview ? (
              <span className="mono-label px-1 py-1">span · kind</span>
            ) : (
              <>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find span…"
                  aria-label="Find span by name"
                  className="input h-7 min-w-0 flex-1 px-2 py-0 text-xs"
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm shrink-0"
                  onClick={collapsed.size ? () => setCollapsed(new Set()) : collapseAll}
                  disabled={searching}
                  title={collapsed.size ? "Expand all" : "Collapse all"}
                >
                  {collapsed.size ? "Expand" : "Collapse"}
                </button>
              </>
            )}
          </div>
          <div className="relative mx-3">
            {TICKS.map((f) => (
              <span
                key={f}
                className={`absolute top-2.5 font-mono text-[10px] whitespace-nowrap text-ink-3 ${
                  f === 0 ? "" : f === 1 ? "-translate-x-full" : "hidden -translate-x-1/2 md:inline"
                }`}
                style={{ left: `${f * 100}%` }}
              >
                {formatDuration(total * f)}
              </span>
            ))}
          </div>
        </div>

        <div className="relative" onKeyDown={preview ? undefined : onListKeyDown}>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 left-[var(--name-col)]"
          >
            <div className="relative mx-3 h-full">
              {TICKS.slice(1, -1).map((f) => (
                <span
                  key={f}
                  className="absolute inset-y-0 w-px bg-line"
                  style={{ left: `${f * 100}%` }}
                />
              ))}
            </div>
          </div>

          <div className="relative divide-y divide-line/60" role="listbox" aria-label="Spans">
            <button
              type="button"
              role="option"
              data-row={0}
              tabIndex={selection.kind === "trace" ? 0 : -1}
              onClick={() => select({ kind: "trace" })}
              aria-selected={selection.kind === "trace"}
              className={`grid w-full grid-cols-[var(--name-col)_1fr] items-stretch text-left transition-colors hover:bg-surface-2/70 ${
                selection.kind === "trace"
                  ? "bg-surface-2 shadow-[inset_2px_0_0_var(--color-ember)]"
                  : ""
              }`}
              disabled={preview}
            >
              <span className="flex min-w-0 items-center gap-2 border-r border-line py-2 pr-3 pl-3">
                <span className="truncate text-sm font-medium text-ink">{trace.name}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  {trace.status !== "ok" && <StatusIcon status={trace.status} />}
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                    trace
                  </span>
                </span>
              </span>
              <span className="relative mx-3 block h-9">
                <span
                  className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-line-2"
                  style={{
                    left: `${((Date.parse(trace.startedAt) - t0) / total) * 100}%`,
                    width: `${Math.max(0.5, (trace.durationMs / total) * 100)}%`,
                  }}
                />
              </span>
            </button>

            {rows.map((row, i) => {
              const span = row.span;
              const start = Date.parse(span.startedAt);
              const left = ((start - t0) / total) * 100;
              const width = Math.max(0, (span.durationMs / total) * 100);
              const selected = selection.kind === "span" && selection.id === span.id;
              const label = labelStyle(left, width);
              return (
                <button
                  key={span.id}
                  type="button"
                  role="option"
                  data-row={i + 1}
                  tabIndex={selected ? 0 : -1}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("[data-toggle]")) {
                      toggle(span.id);
                      return;
                    }
                    select({ kind: "span", id: span.id });
                  }}
                  aria-selected={selected}
                  disabled={preview}
                  className={`group grid w-full grid-cols-[var(--name-col)_1fr] items-stretch text-left transition-colors hover:bg-surface-2/70 focus-visible:bg-surface-2/70 ${
                    selected ? "bg-surface-2 shadow-[inset_2px_0_0_var(--color-ember)]" : ""
                  }`}
                >
                  <span
                    className="flex min-w-0 items-center gap-2 border-r border-line py-2 pr-3"
                    style={{ paddingLeft: 12 + Math.min(row.depth, 8) * 14 }}
                  >
                    {row.depth > 0 && <span className="h-px w-2 shrink-0 bg-line-2" aria-hidden />}
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: KIND_COLOR[span.kind] }}
                      aria-hidden
                    />
                    <span className="truncate text-sm text-ink">{span.name}</span>
                    {row.children.length > 0 && !preview && !searching && (
                      <span
                        data-toggle
                        title={collapsed.has(span.id) ? "Expand" : "Collapse"}
                        className="shrink-0 rounded px-1 font-mono text-[10px] text-ink-3 hover:bg-surface-3 hover:text-ink"
                      >
                        {collapsed.has(span.id) ? `+${descendantCount(row)}` : "−"}
                      </span>
                    )}
                    {row.orphan && (
                      <span
                        className="chip shrink-0 border-warn/50 text-warn"
                        title="parentSpanId is not in this trace"
                      >
                        orphan
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {(totalTokens(span.usage) !== null || span.costUsd !== null) && (
                        <span className="hidden font-mono text-[10px] text-ink-3 md:inline">
                          {[
                            totalTokens(span.usage) !== null
                              ? `${formatTokens(totalTokens(span.usage))} tok`
                              : null,
                            span.costUsd !== null ? formatCost(span.costUsd) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                      {span.status !== "ok" && <StatusIcon status={span.status} />}
                      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                        {span.kind}
                      </span>
                    </span>
                  </span>
                  <span className="relative mx-3 block h-9">
                    <span
                      className="bar-grow absolute top-1/2 h-2.5 -translate-y-1/2 rounded-r-[4px] transition-[filter] group-hover:brightness-125"
                      style={{
                        left: `${left}%`,
                        width: `max(3px, ${width}%)`,
                        background: KIND_COLOR[span.kind],
                        animationDelay: `${Math.min(i, 24) * 18}ms`,
                      }}
                    />
                    <span
                      className={`absolute top-1/2 -translate-y-1/2 font-mono text-[11px] whitespace-nowrap text-ink-2 ${
                        label.plate ? "rounded-sm border border-line-2 bg-bg-2/95 px-1.5 py-px" : ""
                      }`}
                      style={label.style}
                    >
                      {formatDuration(span.durationMs)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-4 py-2.5">
          {kindsPresent.map((kind: SpanKind) => (
            <span
              key={kind}
              className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-ink-3"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: KIND_COLOR[kind] }}
                aria-hidden
              />
              {kind}
            </span>
          ))}
          {(tree.orphanCount > 0 || tree.cycles.length > 0) && (
            <span className="ml-auto font-mono text-[10px] text-warn">
              {tree.orphanCount > 0
                ? `${tree.orphanCount} orphan span${tree.orphanCount === 1 ? "" : "s"} shown as roots`
                : ""}
              {tree.cycles.length > 0 ? ` · ${tree.cycles.length} parent cycle flattened` : ""}
            </span>
          )}
        </div>
      </div>

      {!preview && (
        <aside className="card p-5 xl:sticky xl:top-20" aria-label="Inspector">
          {selectedSpan ? (
            <>
              <div className="mb-4 flex items-start gap-3">
                <span
                  className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: KIND_COLOR[selectedSpan.kind] }}
                  aria-hidden
                />
                <div className="min-w-0">
                  <h2
                    className="truncate font-display text-2xl leading-tight text-ink"
                    title={selectedSpan.name}
                  >
                    {selectedSpan.name}
                  </h2>
                  <p className="font-mono text-[11px] text-ink-3">span · {selectedSpan.kind}</p>
                </div>
              </div>
              <Tabs items={spanTabs(selectedSpan)} value={tab} onChange={setTab} />
            </>
          ) : (
            <>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2
                    className="truncate font-display text-2xl leading-tight text-ink"
                    title={trace.name}
                  >
                    {trace.name}
                  </h2>
                  <p className="font-mono text-[11px] text-ink-3">trace</p>
                </div>
                <a
                  href={`/api/projects/${projectId}/traces/${trace.id}/export`}
                  className="btn btn-ghost btn-sm shrink-0"
                  download={`firetrace-${trace.id}.json`}
                >
                  Download JSON
                </a>
              </div>
              <Tabs items={traceTabs} value={tab} onChange={setTab} />
            </>
          )}
        </aside>
      )}
    </div>
  );
}
