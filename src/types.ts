import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "./models";

export type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type StopDetails = Anthropic.Beta.Messages.BetaRefusalStopDetails;

export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "pdf";
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf";
  /** Base64 without a data: prefix. */
  data: string;
  size: number;
}

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUSD: number;
  /** True when part of the cost could not be priced exactly (unknown model, stopped early). */
  estimated: boolean;
}

/** One API response. A paused turn (pause_turn) that resumes produces several segments. */
export interface AssistantSegment {
  content: ContentBlock[];
  model: string;
  stopReason: string | null;
}

export type MessageStatus = "complete" | "streaming" | "stopped" | "error" | "refused";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  createdAt: number;
  // user turns
  text?: string;
  attachments?: Attachment[];
  // assistant turns
  segments?: AssistantSegment[];
  requestedModel?: string;
  status?: MessageStatus;
  stopDetails?: StopDetails | null;
  usage?: UsageSummary;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  effort: Effort;
  /** Frozen when the first message is sent, so the prompt cache and thinking stay valid. */
  systemPrompt: string;
  webSearch: boolean;
  /** True once the first request has gone out: system prompt and web search are locked. */
  started: boolean;
  messages: ChatMessage[];
}

export interface UsageRecord {
  id: string;
  ts: number;
  conversationId: string;
  model: string;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export type Theme = "system" | "light" | "dark";

export interface Limits {
  /** 0 means no limit. */
  dailyUSD: number;
  monthlyUSD: number;
  messagesPerWindow: number;
  windowHours: number;
}

export interface Settings {
  defaultModel: string;
  defaultEffort: Effort;
  maxTokens: number;
  systemPrompt: string;
  includeDate: boolean;
  webSearchDefault: boolean;
  showThinking: boolean;
  enterToSend: boolean;
  theme: Theme;
  limits: Limits;
}

export interface RateLimitSnapshot {
  at: number;
  available: boolean;
  requestsRemaining?: number;
  requestsLimit?: number;
  inputTokensRemaining?: number;
  inputTokensLimit?: number;
  outputTokensRemaining?: number;
  outputTokensLimit?: number;
  resetAt?: string;
}
