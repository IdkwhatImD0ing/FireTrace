"use client";

import { useState } from "react";
import { JsonView } from "@/components/ui/JsonView";
import { detectChatMessages, type ChatMessage } from "@/lib/firetrace/chat-format";
import type { JsonValue } from "@/lib/firetrace/schema";

const PREVIEW_CHARS = 4_000;
const RECENT_MESSAGES = 50;

const ROLE_TONE: Record<string, string> = {
  user: "text-k-agent",
  assistant: "text-ember-2",
  system: "text-ink-3",
  tool: "text-k-tool",
};

function Message({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const text = message.content ?? "";
  const long = text.length > PREVIEW_CHARS;
  const shown = long && !expanded ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  return (
    <li className="rounded-md border border-line bg-bg-2 p-3">
      <div className="flex items-center gap-2">
        <span
          className={`font-mono text-[10px] uppercase tracking-wider ${ROLE_TONE[message.role] ?? "text-ink-2"}`}
        >
          {message.role}
          {message.name ? ` · ${message.name}` : ""}
        </span>
        {message.toolCallId && (
          <span className="font-mono text-[10px] text-ink-3" title="tool_call_id">
            {message.toolCallId}
          </span>
        )}
      </div>
      {text && <p className="mt-1.5 text-sm break-words whitespace-pre-wrap text-ink">{shown}</p>}
      {long && (
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-1"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : `Show all (${text.length.toLocaleString("en-US")} chars)`}
        </button>
      )}
      {message.toolCalls?.map((call, i) => (
        <div key={i} className="mt-2">
          <span className="font-mono text-[11px] text-k-tool">{call.name}(…)</span>
          <pre className="pre mt-1 max-h-48 overflow-auto">{call.arguments}</pre>
        </div>
      ))}
    </li>
  );
}

/** Chat-shaped input/output as role-labelled messages, with a JSON toggle; else plain JSON. */
export function MessageList({
  value,
  emptyLabel,
}: {
  value: JsonValue | null;
  emptyLabel?: string;
}) {
  const [mode, setMode] = useState<"chat" | "json">("chat");
  const [showAll, setShowAll] = useState(false);
  const messages = detectChatMessages(value);
  if (!messages) return <JsonView value={value} emptyLabel={emptyLabel} />;
  const hidden = showAll ? 0 : Math.max(0, messages.length - RECENT_MESSAGES);
  const visible = messages.slice(hidden);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-ink-3">
          {messages.length} message{messages.length === 1 ? "" : "s"}
        </span>
        <div className="flex gap-1" role="group" aria-label="View as">
          {(["chat", "json"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`btn btn-sm ${mode === m ? "btn-primary" : "btn-ghost"}`}
            >
              {m === "chat" ? "Chat" : "JSON"}
            </button>
          ))}
        </div>
      </div>
      {mode === "json" ? (
        <JsonView value={value} emptyLabel={emptyLabel} />
      ) : (
        <ol className="space-y-2">
          {hidden > 0 && (
            <li>
              <button
                type="button"
                className="btn btn-ghost btn-sm w-full"
                onClick={() => setShowAll(true)}
              >
                Show {hidden} earlier message{hidden === 1 ? "" : "s"}
              </button>
            </li>
          )}
          {visible.map((message, i) => (
            <Message key={hidden + i} message={message} />
          ))}
        </ol>
      )}
    </div>
  );
}
