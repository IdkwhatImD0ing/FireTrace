/**
 * Recognize chat-shaped input/output so the inspector can show role-labelled
 * messages instead of raw JSON. Pure and forgiving: anything that is not
 * clearly a message list returns null and falls back to the JSON view.
 *
 * Handled shapes: an array of `{ role, content }` messages (content as a
 * string, null, or OpenAI/Anthropic content parts), `{ messages: [...] }` with
 * an optional top-level Anthropic `system`, an OpenAI chat completion
 * (`choices[].message`), and an Anthropic message (`type: "message"`).
 */

export interface ChatToolCall {
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: string;
  content: string | null;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  name?: string;
}

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

function messageFrom(item: unknown): ChatMessage | null {
  if (!isRecord(item) || typeof item.role !== "string") return null;
  const toolCalls: ChatToolCall[] = [];
  let content: string | null;
  if (typeof item.content === "string") {
    content = item.content;
  } else if (item.content === null || item.content === undefined) {
    content = null;
  } else if (Array.isArray(item.content)) {
    const parts: string[] = [];
    for (const part of item.content) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (!isRecord(part)) {
        return null;
      } else if (typeof part.text === "string") {
        parts.push(part.text);
      } else if (part.type === "tool_use") {
        toolCalls.push({ name: String(part.name ?? "tool"), arguments: stringify(part.input) });
      } else if (part.type === "tool_result") {
        parts.push(typeof part.content === "string" ? part.content : stringify(part.content));
      } else if (
        part.type === "image" ||
        part.type === "image_url" ||
        part.type === "input_image"
      ) {
        parts.push("[image]");
      } else {
        parts.push(stringify(part));
      }
    }
    content = parts.join("\n");
  } else {
    return null;
  }
  if (Array.isArray(item.tool_calls)) {
    for (const call of item.tool_calls) {
      const fn = isRecord(call) && isRecord(call.function) ? call.function : null;
      if (fn && typeof fn.name === "string") {
        toolCalls.push({
          name: fn.name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : stringify(fn.arguments),
        });
      }
    }
  }
  return {
    role: item.role,
    content,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(typeof item.tool_call_id === "string" ? { toolCallId: item.tool_call_id } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
  };
}

function messagesFrom(list: unknown[]): ChatMessage[] | null {
  if (list.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const item of list) {
    const message = messageFrom(item);
    if (!message) return null;
    out.push(message);
  }
  return out;
}

/** The messages in `value`, or null when it is not chat-shaped. */
export function detectChatMessages(value: unknown): ChatMessage[] | null {
  if (Array.isArray(value)) return messagesFrom(value);
  if (!isRecord(value)) return null;
  if (Array.isArray(value.messages)) {
    const messages = messagesFrom(value.messages);
    if (!messages) return null;
    return typeof value.system === "string"
      ? [{ role: "system", content: value.system }, ...messages]
      : messages;
  }
  if (Array.isArray(value.choices)) {
    const picked = value.choices.map((c) => (isRecord(c) ? c.message : null)).filter(Boolean);
    return picked.length ? messagesFrom(picked) : null;
  }
  if (value.type === "message" && Array.isArray(value.content)) {
    const message = messageFrom({ role: value.role ?? "assistant", content: value.content });
    return message ? [message] : null;
  }
  if (typeof value.role === "string" && "content" in value) {
    const message = messageFrom(value);
    return message ? [message] : null;
  }
  return null;
}
