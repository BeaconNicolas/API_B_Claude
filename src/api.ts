// Talks to the Claude API straight from the browser with the user's own key.

import Anthropic from "@anthropic-ai/sdk";
import {
  buildRequest,
  MAX_PAUSE_CONTINUATIONS,
  parseRateLimits,
  partialTextOnly,
  summariseUsage,
  addUsage,
  emptyUsage,
} from "./conversation";
import { demoFetch } from "./demo";
import type { AssistantSegment, ContentBlock, Conversation, RateLimitSnapshot, StopDetails, UsageSummary } from "./types";

export function createClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    // The key is the user's own, typed into this page and sent only to api.anthropic.com.
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}

/** A client whose requests are answered in the browser by demo mode; nothing leaves the page. */
export function createDemoClient(): Anthropic {
  return new Anthropic({
    apiKey: "demo-mode",
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    fetch: demoFetch,
  });
}

/** Cheap call to check a key works. */
export async function verifyKey(apiKey: string): Promise<void> {
  await createClient(apiKey).models.list({ limit: 1 });
}

export interface StreamCallbacks {
  /** Called (throttled by the caller) with every snapshot of the response so far. */
  onUpdate(segments: AssistantSegment[], live: ContentBlock[], liveModel: string | null): void;
  onRateLimits(snapshot: RateLimitSnapshot): void;
}

export interface TurnResult {
  status: "complete" | "stopped" | "refused";
  segments: AssistantSegment[];
  stopDetails: StopDetails | null;
  usage: UsageSummary;
}

/**
 * Run one assistant turn: stream the response, resume `pause_turn` (server tools hit
 * their iteration limit) up to a few times, and return everything needed to store it.
 * Throws the SDK's typed errors for API failures; an abort returns status "stopped".
 */
export async function runTurn(
  client: Anthropic,
  conversation: Conversation,
  maxTokens: number,
  signal: AbortSignal,
  callbacks: StreamCallbacks,
): Promise<TurnResult> {
  const segments: AssistantSegment[] = [];
  let usage = emptyUsage();

  for (let round = 0; round <= MAX_PAUSE_CONTINUATIONS; round++) {
    const params = buildRequest({ conversation, maxTokens, continuation: segments });
    const stream = client.beta.messages.stream(params, { signal });

    stream.on("connect", () => {
      callbacks.onRateLimits(parseRateLimits(stream.response?.headers));
    });
    stream.on("streamEvent", (_event, snapshot) => {
      callbacks.onUpdate(segments, snapshot.content, snapshot.model ?? null);
    });

    let message: Anthropic.Beta.Messages.BetaMessage;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError || signal.aborted) {
        const partial = stream.currentMessage;
        if (partial) {
          const text = partialTextOnly(partial.content);
          if (text.length) segments.push({ content: text, model: partial.model, stopReason: "stopped" });
          // Output tokens for an interrupted stream aren't final; input and cache counts are.
          usage = addUsage(usage, summariseUsage(partial.usage, partial.model, true));
        }
        return { status: "stopped", segments, stopDetails: null, usage };
      }
      throw err;
    }

    usage = addUsage(usage, summariseUsage(message.usage, message.model));
    segments.push({ content: message.content, model: message.model, stopReason: message.stop_reason });
    callbacks.onUpdate(segments, [], null);

    if (message.stop_reason === "refusal") {
      // The whole fallback chain declined (or this model has no fallback).
      return { status: "refused", segments, stopDetails: message.stop_details, usage };
    }
    if (message.stop_reason !== "pause_turn") {
      return { status: "complete", segments, stopDetails: null, usage };
    }
    // pause_turn: send the paused turn back unchanged and the server resumes it.
  }
  return { status: "complete", segments, stopDetails: null, usage };
}

/** A short, human explanation for an API error. */
export function describeError(err: unknown): { message: string; needsKey?: boolean; retryAfter?: number } {
  if (err instanceof Anthropic.AuthenticationError) {
    return { message: "Your API key was rejected. Check it in Settings.", needsKey: true };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { message: "This API key isn't allowed to use that model or feature." };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { message: "That model isn't available to your API key." };
  }
  if (err instanceof Anthropic.RateLimitError) {
    const retry = Number(err.headers?.get("retry-after"));
    return {
      message: Number.isFinite(retry)
        ? `Rate limit reached. Try again in about ${Math.ceil(retry)} seconds.`
        : "Rate limit reached. Wait a moment and try again.",
      retryAfter: Number.isFinite(retry) ? retry : undefined,
    };
  }
  if (err instanceof Anthropic.BadRequestError) {
    const detail = (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
    if (/credit balance/i.test(detail)) {
      return { message: "Your API credit balance is too low. Add credits in the Claude Console." };
    }
    return { message: `The request was rejected: ${detail}` };
  }
  if (err instanceof Anthropic.InternalServerError) {
    return { message: err.status === 529 ? "Claude is overloaded right now. Try again shortly." : "Claude had a server error. Try again." };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { message: "Couldn't reach the Claude API. Check your connection." };
  }
  if (err instanceof Anthropic.APIError) {
    return { message: `API error ${err.status ?? ""}: ${err.message}`.trim() };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}
