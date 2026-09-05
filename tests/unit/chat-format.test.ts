import { describe, expect, it } from "vitest";
import { detectChatMessages } from "@/lib/firetrace/chat-format";

describe("detectChatMessages", () => {
  it("recognizes message arrays and {messages} objects, with an Anthropic system prompt", () => {
    const list = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ function: { name: "lookup", arguments: '{"q":1}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "42" },
    ];
    expect(detectChatMessages(list)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: null, toolCalls: [{ name: "lookup", arguments: '{"q":1}' }] },
      { role: "tool", content: "42", toolCallId: "c1" },
    ]);
    expect(detectChatMessages({ messages: list.slice(0, 1), system: "be brief" })).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("flattens content parts from OpenAI and Anthropic shapes", () => {
    expect(
      detectChatMessages([
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:..." } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "sure" },
            { type: "tool_use", name: "search", input: { q: "x" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", content: [{ type: "text", text: "found" }] }],
        },
      ]),
    ).toEqual([
      { role: "user", content: "look\n[image]" },
      {
        role: "assistant",
        content: "sure",
        toolCalls: [{ name: "search", arguments: '{\n  "q": "x"\n}' }],
      },
      { role: "user", content: '[\n  {\n    "type": "text",\n    "text": "found"\n  }\n]' },
    ]);
  });

  it("reads provider responses", () => {
    expect(
      detectChatMessages({
        id: "chatcmpl",
        choices: [{ index: 0, message: { role: "assistant", content: "done" } }],
      }),
    ).toEqual([{ role: "assistant", content: "done" }]);
    expect(
      detectChatMessages({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      }),
    ).toEqual([{ role: "assistant", content: "ok" }]);
    expect(detectChatMessages({ role: "assistant", content: "single" })).toEqual([
      { role: "assistant", content: "single" },
    ]);
  });

  it("returns null for anything else", () => {
    expect(detectChatMessages({ prompt: "Explain vector search." })).toBeNull();
    expect(detectChatMessages({ text: "answer" })).toBeNull();
    expect(detectChatMessages([])).toBeNull();
    expect(detectChatMessages([{ role: "user" }, "not a message"])).toBeNull();
    expect(detectChatMessages([{ content: "no role" }])).toBeNull();
    expect(detectChatMessages({ messages: [{ role: "user", content: 42 }] })).toBeNull();
    expect(detectChatMessages("plain string")).toBeNull();
    expect(detectChatMessages(null)).toBeNull();
  });
});
