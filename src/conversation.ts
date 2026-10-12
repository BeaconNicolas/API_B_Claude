// Pure logic for turning a stored conversation into an API request, and for
// pricing and limits. Kept free of DOM and network code so it can be unit tested.

import type Anthropic from "@anthropic-ai/sdk";
import { getModel, pricingFor, WEB_SEARCH_PRICE_PER_SEARCH } from "./models";
import type {
  AssistantSegment,
  ChatMessage,
  ContentBlock,
  Conversation,
  Limits,
  RateLimitSnapshot,
  UsageRecord,
  UsageSummary,
} from "./types";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type Usage = Anthropic.Beta.Messages.BetaUsage;

export const BETA_FALLBACK = "server-side-fallback-2026-07-01";
export const BETA_THINKING_BINDING = "thinking-binding-controls-2026-08-01";
export const MAX_PAUSE_CONTINUATIONS = 5;

// Blocks that are safe to replay when they come before a refusal-fallback switch point.
const KEEP_BEFORE_FALLBACK = new Set(["text", "web_search_tool_result", "web_fetch_tool_result"]);
// Blocks a stopped (aborted) response can contribute: only finished text is trustworthy.
const PAIRED_SERVER_RESULTS: Record<string, string> = {
  web_search_tool_result: "server_tool_use",
  web_fetch_tool_result: "server_tool_use",
};

/**
 * Prepare an assistant response for replay. After a mid-output refusal fallback the API
 * asks us to omit thinking, tool_use and unpaired server_tool_use blocks (and unknown
 * block types) that come before the last `fallback` block; text and paired server-tool
 * blocks stay. The `fallback` marker itself is dropped.
 */
export function echoContent(content: ContentBlock[]): ContentBlock[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf("fallback");
  if (lastFallback === -1) return content.filter((b) => b.type !== "fallback");

  const before = content.slice(0, lastFallback);
  const resultIds = new Set(
    before
      .filter((b) => b.type in PAIRED_SERVER_RESULTS)
      .map((b) => (b as { tool_use_id?: string }).tool_use_id)
      .filter(Boolean),
  );
  const keptBefore = before.filter((b) => {
    if (b.type === "server_tool_use") return resultIds.has((b as { id: string }).id);
    return KEEP_BEFORE_FALLBACK.has(b.type);
  });
  const after = content.slice(lastFallback + 1).filter((b) => b.type !== "fallback");
  return [...keptBefore, ...after];
}

/** From a stopped response keep only non-empty text, without citations. */
export function partialTextOnly(content: ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text.trim()) {
      out.push({ type: "text", text: block.text, citations: null } as ContentBlock);
    }
  }
  return out;
}

function userContent(message: ChatMessage): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const a of message.attachments ?? []) {
    if (a.kind === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: a.mediaType as "image/png", data: a.data },
      });
    } else {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: a.data },
        title: a.name,
      });
    }
  }
  blocks.push({ type: "text", text: message.text?.trim() ? message.text : "(no text)" });
  return blocks;
}

/**
 * Build the `messages` array for a request. The history is append-only and rebuilt
 * deterministically every time, so prompt caching and preserved thinking keep working.
 * Refused or failed turns are left out; consecutive same-role turns are allowed.
 */
export function buildMessages(messages: ChatMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: userContent(m) });
      continue;
    }
    if (m.status === "refused" || m.status === "error" || !m.segments?.length) continue;
    if (m.status === "stopped") {
      const text = m.segments.flatMap((s) => partialTextOnly(s.content));
      if (text.length) out.push({ role: "assistant", content: text as ContentBlockParam[] });
      continue;
    }
    for (const segment of m.segments) {
      const content = echoContent(segment.content);
      if (content.length) out.push({ role: "assistant", content: content as ContentBlockParam[] });
    }
  }
  return out;
}

export function webSearchTool(modelId: string): Anthropic.Beta.Messages.BetaToolUnion {
  const type = getModel(modelId).webSearchTool;
  return { type, name: "web_search", max_uses: 5 } as Anthropic.Beta.Messages.BetaToolUnion;
}

export interface RequestOptions {
  conversation: Conversation;
  maxTokens: number;
  /** Assistant segments already produced this turn (pause_turn continuation). */
  continuation?: AssistantSegment[];
}

export function buildRequest({
  conversation,
  maxTokens,
  continuation,
}: RequestOptions): Anthropic.Beta.Messages.MessageCreateParamsStreaming {
  const model = getModel(conversation.model);
  const messages = buildMessages(conversation.messages);
  for (const segment of continuation ?? []) {
    messages.push({ role: "assistant", content: echoContent(segment.content) as ContentBlockParam[] });
  }
  const betas: Anthropic.Beta.AnthropicBeta[] = [BETA_THINKING_BINDING];
  if (model.supportsFallback) betas.unshift(BETA_FALLBACK);

  const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
    model: model.id,
    max_tokens: Math.min(Math.max(1024, maxTokens), model.maxOutput),
    messages,
    // Summarised reasoning is shown in the UI; if a replayed thinking block no longer
    // matches its conversation, drop it instead of failing the request.
    thinking: {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    },
    output_config: { effort: conversation.effort },
    // Automatic prompt caching: the API caches the conversation prefix between turns.
    cache_control: { type: "ephemeral" },
    betas,
    stream: true,
  };
  if (conversation.systemPrompt) params.system = [{ type: "text", text: conversation.systemPrompt }];
  if (conversation.webSearch) params.tools = [webSearchTool(model.id)];
  if (model.supportsFallback) params.fallbacks = "default";
  return params;
}

/** The frozen system prompt for a conversation's first request. */
export function composeSystemPrompt(base: string, includeDate: boolean, now = new Date()): string {
  const parts: string[] = [];
  if (includeDate) {
    const date = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    parts.push(`Today's date is ${date}.`);
  }
  if (base.trim()) parts.push(base.trim());
  return parts.join("\n\n");
}

// ---------- usage and cost ----------

export function emptyUsage(): UsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
    costUSD: 0,
    estimated: false,
  };
}

interface TokenCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function priceTokens(model: string | null | undefined, fallbackModel: string, t: TokenCounts) {
  const input = t.input_tokens ?? 0;
  const output = t.output_tokens ?? 0;
  const cacheRead = t.cache_read_input_tokens ?? 0;
  const cacheWrite = t.cache_creation_input_tokens ?? 0;
  const prompt = input + cacheRead + cacheWrite;
  let pricing = pricingFor(model ?? fallbackModel, prompt);
  let estimated = false;
  if (!pricing) {
    pricing = pricingFor(fallbackModel, prompt) ?? getModel(fallbackModel).pricing;
    estimated = true;
  }
  const cost =
    (input * pricing.input + output * pricing.output + cacheRead * pricing.cacheRead + cacheWrite * pricing.cacheWrite) /
    1_000_000;
  return { input, output, cacheRead, cacheWrite, cost, estimated };
}

/**
 * Turn an API usage object into tokens and an estimated cost. With refusal fallbacks the
 * per-attempt `iterations` array is the source of truth (top-level usage only covers the
 * attempt that produced the message), so price each attempt at its own model's rates.
 */
export function summariseUsage(usage: Usage | null | undefined, responseModel: string, estimated = false): UsageSummary {
  const summary = emptyUsage();
  summary.estimated = estimated;
  if (!usage) return summary;
  const attempts = (usage.iterations ?? []).filter((i) => i.type === "message" || i.type === "fallback_message");
  const parts = attempts.length
    ? attempts.map((i) => priceTokens((i as { model?: string | null }).model, responseModel, i))
    : [priceTokens(responseModel, responseModel, usage)];
  for (const p of parts) {
    summary.inputTokens += p.input;
    summary.outputTokens += p.output;
    summary.cacheReadTokens += p.cacheRead;
    summary.cacheWriteTokens += p.cacheWrite;
    summary.costUSD += p.cost;
    summary.estimated ||= p.estimated;
  }
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  summary.webSearches = searches;
  summary.costUSD += searches * WEB_SEARCH_PRICE_PER_SEARCH;
  return summary;
}

export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    webSearches: a.webSearches + b.webSearches,
    costUSD: a.costUSD + b.costUSD,
    estimated: a.estimated || b.estimated,
  };
}

export function conversationUsage(conversation: Conversation): UsageSummary {
  return conversation.messages.reduce((sum, m) => (m.usage ? addUsage(sum, m.usage) : sum), emptyUsage());
}

/** Tokens the conversation currently occupies in the context window (last request). */
export function contextTokens(conversation: Conversation): number {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const u = conversation.messages[i].usage;
    if (u && (u.inputTokens || u.cacheReadTokens || u.cacheWriteTokens)) {
      return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens;
    }
  }
  return 0;
}

// ---------- your own limits ----------

export interface LimitStatus {
  todayUSD: number;
  monthUSD: number;
  windowMessages: number;
  windowResetAt: number | null;
  blocked: string | null;
  warnings: string[];
}

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfMonth(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

export function checkLimits(records: UsageRecord[], limits: Limits, now = Date.now()): LimitStatus {
  const dayStart = startOfDay(now);
  const monthStart = startOfMonth(now);
  const windowMs = Math.max(1, limits.windowHours) * 3_600_000;
  const windowStart = now - windowMs;
  let todayUSD = 0;
  let monthUSD = 0;
  const inWindow: number[] = [];
  for (const r of records) {
    if (r.ts >= monthStart) monthUSD += r.costUSD;
    if (r.ts >= dayStart) todayUSD += r.costUSD;
    if (r.ts >= windowStart) inWindow.push(r.ts);
  }
  inWindow.sort((a, b) => a - b);
  const status: LimitStatus = {
    todayUSD,
    monthUSD,
    windowMessages: inWindow.length,
    windowResetAt: inWindow.length ? inWindow[0] + windowMs : null,
    blocked: null,
    warnings: [],
  };
  const check = (used: number, cap: number, what: string) => {
    if (cap <= 0) return;
    if (used >= cap) status.blocked ??= what;
    else if (used >= cap * 0.8) status.warnings.push(what);
  };
  check(todayUSD, limits.dailyUSD, "daily spending limit");
  check(monthUSD, limits.monthlyUSD, "monthly spending limit");
  check(inWindow.length, limits.messagesPerWindow, `${limits.windowHours}-hour message limit`);
  return status;
}

// ---------- rate limits from response headers ----------

function num(headers: Headers, name: string): number | undefined {
  const v = headers.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseRateLimits(headers: Headers | null | undefined, now = Date.now()): RateLimitSnapshot {
  if (!headers) return { at: now, available: false };
  const snap: RateLimitSnapshot = {
    at: now,
    available: false,
    requestsRemaining: num(headers, "anthropic-ratelimit-requests-remaining"),
    requestsLimit: num(headers, "anthropic-ratelimit-requests-limit"),
    inputTokensRemaining: num(headers, "anthropic-ratelimit-input-tokens-remaining"),
    inputTokensLimit: num(headers, "anthropic-ratelimit-input-tokens-limit"),
    outputTokensRemaining: num(headers, "anthropic-ratelimit-output-tokens-remaining"),
    outputTokensLimit: num(headers, "anthropic-ratelimit-output-tokens-limit"),
    resetAt:
      headers.get("anthropic-ratelimit-requests-reset") ??
      headers.get("anthropic-ratelimit-input-tokens-reset") ??
      undefined,
  };
  snap.available = [snap.requestsRemaining, snap.inputTokensRemaining, snap.outputTokensRemaining].some(
    (v) => v !== undefined,
  );
  return snap;
}

// ---------- titles and text helpers ----------

export function titleFrom(text: string): string {
  const firstLine = text.replace(/\s+/g, " ").trim();
  if (!firstLine) return "New chat";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
}

/** Plain text of an assistant message (for copying and search). */
export function assistantText(message: ChatMessage): string {
  return (message.segments ?? [])
    .flatMap((s) => s.content)
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}
