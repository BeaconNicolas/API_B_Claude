import { describe, expect, it } from "vitest";
import {
  BETA_FALLBACK,
  BETA_THINKING_BINDING,
  buildMessages,
  buildRequest,
  checkLimits,
  composeSystemPrompt,
  echoContent,
  parseRateLimits,
  summariseUsage,
  titleFrom,
} from "./conversation";
import type { ChatMessage, ContentBlock, Conversation, UsageRecord } from "./types";

const text = (t: string) => ({ type: "text", text: t, citations: null }) as ContentBlock;
const thinking = (t: string) => ({ type: "thinking", thinking: t, signature: "sig" }) as ContentBlock;
const fallback = (from: string, to: string) =>
  ({ type: "fallback", from: { model: from }, to: { model: to }, trigger: { type: "refusal" } }) as unknown as ContentBlock;

function conv(partial: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    model: "claude-opus-5-5",
    effort: "medium",
    systemPrompt: "",
    webSearch: false,
    started: true,
    messages: [],
    ...partial,
  };
}

const user = (t: string): ChatMessage => ({ id: t, role: "user", createdAt: 0, text: t });
const assistant = (content: ContentBlock[], status: ChatMessage["status"] = "complete"): ChatMessage => ({
  id: `a-${Math.random()}`,
  role: "assistant",
  createdAt: 0,
  status,
  segments: [{ content, model: "claude-opus-5-5", stopReason: "end_turn" }],
});

describe("echoContent", () => {
  it("keeps normal responses unchanged", () => {
    const content = [thinking("hmm"), text("Hello")];
    expect(echoContent(content)).toEqual(content);
  });

  it("drops thinking before the last fallback block and the marker itself", () => {
    const content = [thinking("a"), text("partial "), fallback("claude-opus-5-5", "claude-opus-4-8"), thinking("b"), text("rest")];
    expect(echoContent(content)).toEqual([text("partial "), thinking("b"), text("rest")]);
  });

  it("keeps paired server tool blocks before a fallback but drops unpaired ones", () => {
    const paired = { type: "server_tool_use", id: "s1", name: "web_search", input: {} } as unknown as ContentBlock;
    const result = { type: "web_search_tool_result", tool_use_id: "s1", content: [] } as unknown as ContentBlock;
    const unpaired = { type: "server_tool_use", id: "s2", name: "web_search", input: {} } as unknown as ContentBlock;
    const out = echoContent([paired, result, unpaired, fallback("a", "b"), text("x")]);
    expect(out).toEqual([paired, result, text("x")]);
  });
});

describe("buildMessages", () => {
  it("builds an append-only history and skips refused and failed turns", () => {
    const messages = buildMessages([
      user("one"),
      assistant([thinking("t"), text("first")]),
      user("two"),
      assistant([], "refused"),
      user("three"),
      { ...assistant([text("x")]), status: "error" },
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages[1].content).toEqual([thinking("t"), text("first")]);
  });

  it("replays only text from a stopped turn", () => {
    const messages = buildMessages([user("q"), assistant([thinking("t"), text("half an ans")], "stopped")]);
    expect(messages[1].content).toEqual([text("half an ans")]);
  });

  it("drops a stopped turn with no text", () => {
    const messages = buildMessages([user("q"), assistant([thinking("t")], "stopped")]);
    expect(messages).toHaveLength(1);
  });

  it("puts attachments before the text", () => {
    const m: ChatMessage = {
      ...user("look"),
      attachments: [{ id: "i", name: "a.png", kind: "image", mediaType: "image/png", data: "AAAA", size: 3 }],
    };
    const [msg] = buildMessages([m]);
    const blocks = msg.content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["image", "text"]);
  });

  it("sends each pause_turn segment as its own assistant message", () => {
    const m = assistant([text("a")]);
    m.segments!.push({ content: [text("b")], model: "claude-opus-5-5", stopReason: "end_turn" });
    expect(buildMessages([user("q"), m]).map((x) => x.role)).toEqual(["user", "assistant", "assistant"]);
  });
});

describe("buildRequest", () => {
  it("uses adaptive thinking, effort, caching and default fallbacks on Opus", () => {
    const req = buildRequest({ conversation: conv({ messages: [user("hi")] }), maxTokens: 64000 });
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(req.cache_control).toEqual({ type: "ephemeral" });
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toEqual([BETA_FALLBACK, BETA_THINKING_BINDING]);
    expect(req.system).toBeUndefined();
    expect(req.tools).toBeUndefined();
  });

  it("doesn't send fallbacks for Haiku", () => {
    const req = buildRequest({ conversation: conv({ model: "claude-haiku-5-5", messages: [user("hi")] }), maxTokens: 64000 });
    expect(req.fallbacks).toBeUndefined();
    expect(req.betas).toEqual([BETA_THINKING_BINDING]);
  });

  it("adds the system prompt and the right web search tool", () => {
    const opus = buildRequest({ conversation: conv({ systemPrompt: "Be brief", webSearch: true, messages: [user("hi")] }), maxTokens: 1000 });
    expect(opus.system).toEqual([{ type: "text", text: "Be brief" }]);
    expect(opus.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]);
    expect(opus.max_tokens).toBe(1024);
    const haiku = buildRequest({ conversation: conv({ model: "claude-haiku-5-5", webSearch: true, messages: [user("hi")] }), maxTokens: 999999 });
    expect(haiku.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
    expect(haiku.max_tokens).toBe(128000);
  });

  it("appends continuation segments after the history", () => {
    const req = buildRequest({
      conversation: conv({ messages: [user("hi")] }),
      maxTokens: 64000,
      continuation: [{ content: [text("partial")], model: "claude-opus-5-5", stopReason: "pause_turn" }],
    });
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("summariseUsage", () => {
  it("prices a plain response", () => {
    const u = summariseUsage(
      { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never,
      "claude-opus-5-5",
    );
    expect(u.costUSD).toBeCloseTo(4 + 2, 6);
    expect(u.estimated).toBe(false);
  });

  it("prices each fallback attempt at its own model's rate", () => {
    const u = summariseUsage(
      {
        input_tokens: 10,
        output_tokens: 10,
        iterations: [
          { type: "message", model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      } as never,
      "claude-opus-4-8",
    );
    expect(u.costUSD).toBeCloseTo(4 + 5, 6);
    expect(u.inputTokens).toBe(2_000_000);
  });

  it("adds web search fees and Haiku's long-prompt price", () => {
    const u = summariseUsage(
      { input_tokens: 200_000, output_tokens: 0, server_tool_use: { web_search_requests: 3 } } as never,
      "claude-haiku-5-5",
    );
    expect(u.costUSD).toBeCloseTo(0.2 * 0.5 + 0.03, 6);
    expect(u.webSearches).toBe(3);
  });

  it("marks unknown models as estimates", () => {
    const u = summariseUsage({ input_tokens: 10, output_tokens: 10 } as never, "claude-unknown-9");
    expect(u.estimated).toBe(true);
  });
});

describe("checkLimits", () => {
  const now = new Date(2026, 9, 12, 15, 0, 0).getTime();
  const rec = (hoursAgo: number, cost: number): UsageRecord => ({
    id: String(hoursAgo),
    ts: now - hoursAgo * 3_600_000,
    conversationId: "c",
    model: "claude-opus-5-5",
    costUSD: cost,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
  });

  it("blocks at the daily cap and warns at 80%", () => {
    const limits = { dailyUSD: 1, monthlyUSD: 0, messagesPerWindow: 0, windowHours: 5 };
    expect(checkLimits([rec(1, 0.85)], limits, now).warnings).toEqual(["daily spending limit"]);
    expect(checkLimits([rec(1, 1)], limits, now).blocked).toBe("daily spending limit");
    expect(checkLimits([rec(20, 5)], limits, now).blocked).toBeNull(); // yesterday
  });

  it("counts messages in a rolling window and reports when it frees up", () => {
    const limits = { dailyUSD: 0, monthlyUSD: 0, messagesPerWindow: 2, windowHours: 5 };
    const status = checkLimits([rec(4, 0), rec(1, 0), rec(6, 0)], limits, now);
    expect(status.windowMessages).toBe(2);
    expect(status.blocked).toBe("5-hour message limit");
    expect(status.windowResetAt).toBe(now - 4 * 3_600_000 + 5 * 3_600_000);
  });
});

describe("helpers", () => {
  it("reads rate-limit headers when the browser can see them", () => {
    const snap = parseRateLimits(new Headers({ "anthropic-ratelimit-requests-remaining": "49", "anthropic-ratelimit-requests-limit": "50" }));
    expect(snap.available).toBe(true);
    expect(snap.requestsRemaining).toBe(49);
    expect(parseRateLimits(new Headers()).available).toBe(false);
    expect(parseRateLimits(null).available).toBe(false);
  });

  it("freezes the date into the system prompt", () => {
    const prompt = composeSystemPrompt("Be brief.", true, new Date(2026, 9, 12));
    expect(prompt).toMatch(/^Today's date is Monday,? 12 October 2026\.\n\nBe brief\.$/);
    expect(composeSystemPrompt("", false)).toBe("");
  });

  it("makes short titles", () => {
    expect(titleFrom("  hello\nworld ")).toBe("hello world");
    expect(titleFrom("x".repeat(80))).toHaveLength(58);
    expect(titleFrom("")).toBe("New chat");
  });
});
