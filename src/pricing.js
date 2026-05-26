/**
 * pricing.js — Anthropic model price table + cost computation.
 *
 * All prices in USD per million tokens (MTok).
 * Sources: https://www.anthropic.com/pricing (May 2026)
 *
 * Keep this file current when Anthropic changes prices — bump the version comment.
 * v1: May 2026
 */

// ---------------------------------------------------------------------------
// Price table
// ---------------------------------------------------------------------------

// model_id patterns: exact string OR prefix match (longest wins).
// cache_write = cost for cache_creation_input_tokens (1.25× base input)
// cache_read  = cost for cache_read_input_tokens (0.1× base input)
const PRICE_TABLE = [
  // Claude 4 family — claude-opus-4
  {
    pattern: "claude-opus-4",
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5,
  },
  // Claude 4 family — claude-sonnet-4 (default/latest workhorse)
  {
    pattern: "claude-sonnet-4",
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
  },
  // Claude 3.7 Sonnet
  {
    pattern: "claude-3-7-sonnet",
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
  },
  // Claude 3.5 Sonnet
  {
    pattern: "claude-3-5-sonnet",
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
  },
  // Claude 3.5 Haiku
  {
    pattern: "claude-3-5-haiku",
    input: 0.8,
    output: 4.0,
    cache_write: 1.0,
    cache_read: 0.08,
  },
  // Claude Haiku 4
  {
    pattern: "claude-haiku-4",
    input: 0.8,
    output: 4.0,
    cache_write: 1.0,
    cache_read: 0.08,
  },
  // Claude 3 Haiku (legacy)
  {
    pattern: "claude-3-haiku",
    input: 0.25,
    output: 1.25,
    cache_write: 0.3,
    cache_read: 0.03,
  },
  // Claude 3 Opus (legacy)
  {
    pattern: "claude-3-opus",
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5,
  },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find the price entry for a model ID.
 * Matches by longest prefix (most-specific wins).
 * Returns a fallback (Sonnet price) with a flag when unknown.
 */
export function getModelPricing(modelId) {
  const id = (modelId || "").toLowerCase();
  let best = null;
  let bestLen = -1;

  for (const entry of PRICE_TABLE) {
    const pat = entry.pattern.toLowerCase();
    if (id.startsWith(pat) && pat.length > bestLen) {
      best = entry;
      bestLen = pat.length;
    }
  }

  if (best) return { ...best, unknown: false };

  // Unknown model — return Sonnet pricing as a safe default, flag it.
  console.warn(`[pricing] Unknown model '${modelId}', using Sonnet pricing as fallback.`);
  return {
    pattern: modelId,
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
    unknown: true,
  };
}

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

/**
 * Compute USD cost from Anthropic API usage object.
 *
 * @param {object} usage — from response.usage:
 *   { input_tokens, output_tokens,
 *     cache_creation_input_tokens?, cache_read_input_tokens? }
 * @param {string} modelId — e.g. "claude-sonnet-4-20250514"
 * @returns {{ usd: number, pricing: object, unknown: boolean }}
 */
export function computeCost(usage, modelId) {
  const pricing = getModelPricing(modelId);

  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;

  // Tokens already counted in input_tokens when cache_read fires, so:
  // billable_input = input_tokens - cache_read_input_tokens (base rate)
  // + cache_creation_input_tokens (write rate)
  // + cache_read_input_tokens (read rate)
  // Simplification: bill all input_tokens at base rate, then add/subtract delta for cache rows.
  const baseInputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheWriteExtraCost =
    (cacheWriteTokens / 1_000_000) * (pricing.cache_write - pricing.input);
  const cacheReadSaving =
    (cacheReadTokens / 1_000_000) * (pricing.input - pricing.cache_read);

  const usd = Math.max(0, baseInputCost + outputCost + cacheWriteExtraCost - cacheReadSaving);

  return { usd, pricing, unknown: pricing.unknown };
}

// ---------------------------------------------------------------------------
// Model family classifier (for insights: Sonnet vs Haiku etc.)
// ---------------------------------------------------------------------------

/**
 * Returns a simplified family label for grouping in the dashboard.
 * 'opus' | 'sonnet' | 'haiku' | 'unknown'
 */
export function modelFamily(modelId) {
  const id = (modelId || "").toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  return "unknown";
}
