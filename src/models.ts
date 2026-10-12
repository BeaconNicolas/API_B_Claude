// Model catalogue: IDs, prices and the per-model request rules this app relies on.
// Prices are USD per million tokens (Anthropic first-party API list prices).

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Pricing {
  input: number;
  output: number;
  cacheWrite: number; // 5-minute cache write
  cacheRead: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  blurb: string;
  contextWindow: number;
  maxOutput: number;
  pricing: Pricing;
  /** Prices that apply when the prompt is longer than `longPromptThreshold` tokens. */
  longPromptPricing?: Pricing;
  longPromptThreshold?: number;
  /** Server-side refusal fallbacks (`fallbacks: "default"`). */
  supportsFallback: boolean;
  webSearchTool: "web_search_20260209" | "web_search_20250305";
}

export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    blurb: "Best all-round model for hard questions, coding and analysis",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    pricing: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    supportsFallback: true,
    webSearchTool: "web_search_20260209",
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    blurb: "Fast and capable for everyday work",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    pricing: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    supportsFallback: true,
    webSearchTool: "web_search_20260209",
  },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    blurb: "Quickest and cheapest, for simple tasks",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    pricing: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    longPromptPricing: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
    longPromptThreshold: 100_000,
    supportsFallback: false,
    webSearchTool: "web_search_20250305",
  },
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    blurb: "Most capable model, for the hardest problems (priciest)",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    pricing: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
    supportsFallback: true,
    webSearchTool: "web_search_20250305",
  },
];

// Models that can answer as a refusal fallback; priced so per-attempt costs stay accurate.
const FALLBACK_PRICING: Record<string, Pricing> = {
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

export const DEFAULT_MODEL = "claude-opus-5-5";

export const EFFORTS: { id: Effort; label: string; hint: string }[] = [
  { id: "low", label: "Low", hint: "Fastest and cheapest" },
  { id: "medium", label: "Medium", hint: "Balanced (recommended)" },
  { id: "high", label: "High", hint: "Thinks more" },
  { id: "xhigh", label: "Extra high", hint: "For hard problems" },
  { id: "max", label: "Max", hint: "Most thorough, most expensive" },
];

export const WEB_SEARCH_PRICE_PER_SEARCH = 10 / 1000; // $10 per 1,000 searches

export function getModel(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? MODELS[0];
}

export function isKnownModel(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}

export function modelLabel(id: string | null | undefined): string {
  if (!id) return "Claude";
  const known = MODELS.find((m) => m.id === id);
  if (known) return known.label;
  return id.replace(/^claude-/, "Claude ").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-/g, " ");
}

/** Pricing for any model ID we might see in a response, or null if unknown. */
export function pricingFor(id: string | null | undefined, promptTokens = 0): Pricing | null {
  if (!id) return null;
  const known = MODELS.find((m) => m.id === id);
  if (known) {
    if (known.longPromptPricing && known.longPromptThreshold && promptTokens > known.longPromptThreshold) {
      return known.longPromptPricing;
    }
    return known.pricing;
  }
  return FALLBACK_PRICING[id] ?? null;
}
