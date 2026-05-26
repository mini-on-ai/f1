/**
 * insights.js — 5 rule-based optimization insights.
 *
 * All computed from D1 via deterministic SQL queries — no LLM, no opinions.
 * Each insight returns { id, title, finding, estimated_savings_usd, detail }.
 *
 * v1 rules:
 *  1. top_expensive   — Top 5 most expensive prompts (7d / 30d)
 *  2. model_mix       — Model-mix analysis + Haiku-savings estimate
 *  3. cache_candidate — Prompt-caching candidates (repeated long inputs)
 *  4. batchable       — Repeat-prompt / batchable workload
 *  5. since_cutover   — Cumulative spend vs Max 5x Agent SDK credit cap
 */

import { getModelPricing, modelFamily } from "./pricing.js";

// ---------------------------------------------------------------------------
// Main entrypoint: run all insights for an account
// ---------------------------------------------------------------------------

/**
 * @param {object} env  — Worker env (DB, etc.)
 * @param {string} accountId
 * @param {string|null} cutoverDate — ISO date string, e.g. "2026-06-15". May be null.
 * @returns {Promise<Array>} array of insight objects
 */
export async function runInsights(env, accountId, cutoverDate = null) {
  const results = await Promise.allSettled([
    insightTopExpensive(env, accountId),
    insightModelMix(env, accountId),
    insightCacheCandidates(env, accountId),
    insightBatchable(env, accountId),
    insightSinceCutover(env, accountId, cutoverDate),
  ]);

  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { id: "error", title: "Insight unavailable", finding: r.reason?.message ?? "Unknown error", estimated_savings_usd: 0, detail: null }
  );
}

// ---------------------------------------------------------------------------
// 1. Top 5 most expensive prompts (7d)
// ---------------------------------------------------------------------------

async function insightTopExpensive(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT model, input_tokens, output_tokens, usd_cost, ts, prompt_prefix
     FROM usage_events
     WHERE account_id = ?
       AND ts >= datetime('now', '-7 days')
       AND status_code >= 200 AND status_code < 300
     ORDER BY usd_cost DESC
     LIMIT 5`
  ).bind(accountId).all();

  const totalWeekSpend = results.reduce((s, r) => s + (r.usd_cost ?? 0), 0);

  const calls = results.map((r) => ({
    ts: r.ts,
    model: r.model,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    usd_cost: r.usd_cost,
    prompt_preview: r.prompt_prefix ? r.prompt_prefix.slice(0, 100) + "…" : null,
  }));

  return {
    id: "top_expensive",
    title: "Top 5 most expensive calls (last 7 days)",
    finding:
      calls.length === 0
        ? "No successful API calls in the last 7 days."
        : `Your 5 most expensive calls account for $${calls.reduce((s, c) => s + c.usd_cost, 0).toFixed(4)} of your $${totalWeekSpend.toFixed(4)} 7-day spend.`,
    estimated_savings_usd: 0, // descriptive insight, no direct savings estimate
    detail: { calls },
  };
}

// ---------------------------------------------------------------------------
// 2. Model-mix + Haiku-savings estimate
// ---------------------------------------------------------------------------

async function insightModelMix(env, accountId) {
  const { results } = await env.DB.prepare(
    `SELECT model,
            COUNT(*) as call_count,
            SUM(input_tokens) as total_input,
            SUM(output_tokens) as total_output,
            SUM(usd_cost) as total_usd
     FROM usage_events
     WHERE account_id = ?
       AND ts >= datetime('now', '-30 days')
       AND status_code >= 200 AND status_code < 300
     GROUP BY model`
  ).bind(accountId).all();

  if (results.length === 0) {
    return {
      id: "model_mix",
      title: "Model mix (last 30 days)",
      finding: "No successful API calls in the last 30 days.",
      estimated_savings_usd: 0,
      detail: null,
    };
  }

  const totalUsd = results.reduce((s, r) => s + (r.total_usd ?? 0), 0);

  // Find Sonnet spend on short-output calls (proxy for Haiku-eligible)
  const { results: shortSonnet } = await env.DB.prepare(
    `SELECT SUM(input_tokens) as ti, SUM(output_tokens) as to_, COUNT(*) as n, SUM(usd_cost) as cost
     FROM usage_events
     WHERE account_id = ?
       AND ts >= datetime('now', '-30 days')
       AND model LIKE '%sonnet%'
       AND output_tokens < 500
       AND status_code >= 200 AND status_code < 300`
  ).bind(accountId).all();

  const shortSonnetRow = shortSonnet[0] ?? {};
  const shortSonnetCost = shortSonnetRow.cost ?? 0;
  const shortSonnetInput = shortSonnetRow.ti ?? 0;
  const shortSonnetOutput = shortSonnetRow.to_ ?? 0;
  const shortSonnetCount = shortSonnetRow.n ?? 0;

  // Estimate Haiku cost for those same calls
  const haikuPricing = getModelPricing("claude-haiku-4");
  const haikuCost =
    (shortSonnetInput / 1_000_000) * haikuPricing.input +
    (shortSonnetOutput / 1_000_000) * haikuPricing.output;

  const savings = Math.max(0, shortSonnetCost - haikuCost);

  const breakdown = results.map((r) => ({
    model: r.model,
    family: modelFamily(r.model),
    calls: r.call_count,
    usd: r.total_usd,
    pct: totalUsd > 0 ? ((r.total_usd / totalUsd) * 100).toFixed(1) : "0.0",
  }));

  const sonnetPct = breakdown
    .filter((b) => b.family === "sonnet")
    .reduce((s, b) => s + parseFloat(b.pct), 0);

  let finding = `Over the last 30 days you spent $${totalUsd.toFixed(4)} across ${results.length} model(s).`;
  if (savings > 0.001) {
    finding += ` ${shortSonnetCount} short-output Sonnet calls (<500 output tokens) cost $${shortSonnetCost.toFixed(4)}. Routing those to Haiku would cost ~$${haikuCost.toFixed(4)} — saving ~$${savings.toFixed(4)}/mo.`;
  } else if (sonnetPct < 20) {
    finding += ` You're already using Haiku or short-output models well.`;
  }

  return {
    id: "model_mix",
    title: "Model mix + Haiku-savings estimate (last 30 days)",
    finding,
    estimated_savings_usd: parseFloat(savings.toFixed(4)),
    detail: { breakdown, short_sonnet_calls: shortSonnetCount },
  };
}

// ---------------------------------------------------------------------------
// 3. Prompt-caching candidates
// ---------------------------------------------------------------------------

async function insightCacheCandidates(env, accountId) {
  // Find input_hash values repeated ≥10× in 7d with input_tokens ≥ 2000
  const { results } = await env.DB.prepare(
    `SELECT input_hash,
            COUNT(*) as repeat_count,
            AVG(input_tokens) as avg_input,
            SUM(usd_cost) as total_usd,
            MAX(prompt_prefix) as sample_prefix
     FROM usage_events
     WHERE account_id = ?
       AND ts >= datetime('now', '-7 days')
       AND input_hash IS NOT NULL
       AND input_tokens >= 2000
       AND status_code >= 200 AND status_code < 300
     GROUP BY input_hash
     HAVING COUNT(*) >= 10
     ORDER BY total_usd DESC
     LIMIT 5`
  ).bind(accountId).all();

  if (results.length === 0) {
    return {
      id: "cache_candidate",
      title: "Prompt-caching candidates (last 7 days)",
      finding: "No repeated long inputs detected (≥10 repeats, ≥2000 input tokens). Nothing obvious to cache.",
      estimated_savings_usd: 0,
      detail: null,
    };
  }

  // Estimate savings: cache_read costs ~10% of base input rate; assume 90% reduction after first write
  let totalSavings = 0;
  const candidates = results.map((r) => {
    // Savings = (repeat_count - 1) × avg_input_tokens × (input_price - cache_read_price) / 1M
    // Using Sonnet pricing as conservative default (model not stored per-hash)
    const inputPricePerMtok = 3.0;
    const cacheReadPricePerMtok = 0.3;
    const repeats = r.repeat_count - 1;
    const estSavings =
      (repeats * r.avg_input * (inputPricePerMtok - cacheReadPricePerMtok)) / 1_000_000;
    totalSavings += estSavings;
    return {
      repeat_count: r.repeat_count,
      avg_input_tokens: Math.round(r.avg_input),
      total_usd: r.total_usd,
      est_savings_usd: parseFloat(estSavings.toFixed(4)),
      sample_preview: r.sample_prefix ? r.sample_prefix.slice(0, 80) + "…" : null,
    };
  });

  return {
    id: "cache_candidate",
    title: "Prompt-caching candidates (last 7 days)",
    finding: `Found ${results.length} repeated long input pattern(s). Adding \`cache_control\` to your system prompt could save ~$${totalSavings.toFixed(4)}/week.`,
    estimated_savings_usd: parseFloat(totalSavings.toFixed(4)),
    detail: { candidates },
  };
}

// ---------------------------------------------------------------------------
// 4. Repeat-prompt / batchable workload
// ---------------------------------------------------------------------------

async function insightBatchable(env, accountId) {
  // Find any full input_hash repeating ≥5× in a 24h rolling window
  const { results } = await env.DB.prepare(
    `SELECT input_hash,
            COUNT(*) as repeat_count,
            MIN(ts) as first_seen,
            MAX(ts) as last_seen,
            SUM(usd_cost) as total_usd,
            AVG(latency_ms) as avg_latency_ms
     FROM usage_events
     WHERE account_id = ?
       AND ts >= datetime('now', '-1 day')
       AND input_hash IS NOT NULL
       AND status_code >= 200 AND status_code < 300
     GROUP BY input_hash
     HAVING COUNT(*) >= 5
     ORDER BY total_usd DESC
     LIMIT 5`
  ).bind(accountId).all();

  if (results.length === 0) {
    return {
      id: "batchable",
      title: "Batchable workloads (last 24 hours)",
      finding: "No identical prompts repeated ≥5× in the last 24 hours. No obvious batching opportunity.",
      estimated_savings_usd: 0,
      detail: null,
    };
  }

  // Batch API gives 50% discount
  const totalUsd = results.reduce((s, r) => s + (r.total_usd ?? 0), 0);
  const savings = totalUsd * 0.5;

  return {
    id: "batchable",
    title: "Batchable workloads (last 24 hours)",
    finding: `${results.length} prompt pattern(s) repeated ≥5× in 24h ($${totalUsd.toFixed(4)} combined). Using the Anthropic Batch API (async, 50% off) for these would save ~$${savings.toFixed(4)}.`,
    estimated_savings_usd: parseFloat(savings.toFixed(4)),
    detail: { patterns: results.map((r) => ({ repeats: r.repeat_count, usd: r.total_usd })) },
  };
}

// ---------------------------------------------------------------------------
// 5. Since-cutover comparison vs Agent SDK credit cap
// ---------------------------------------------------------------------------

async function insightSinceCutover(env, accountId, cutoverDate) {
  if (!cutoverDate) {
    return {
      id: "since_cutover",
      title: "Spend since claude -p cutover",
      finding: "Set your cutover date via the dashboard to enable this comparison.",
      estimated_savings_usd: 0,
      detail: null,
    };
  }

  const { results } = await env.DB.prepare(
    `SELECT SUM(usd_cost) as total_usd,
            SUM(input_tokens + output_tokens) as total_tokens,
            COUNT(*) as call_count
     FROM usage_events
     WHERE account_id = ?
       AND ts >= ?
       AND status_code >= 200 AND status_code < 300`
  ).bind(accountId, cutoverDate).all();

  const row = results[0] ?? {};
  const totalUsd = row.total_usd ?? 0;
  const totalTokens = row.total_tokens ?? 0;
  const callCount = row.call_count ?? 0;

  // Max 5x plan: $100/mo Agent SDK credit cap
  const AGENT_SDK_CREDIT_CAP = 100.0;

  const daysSinceCutover = Math.max(
    1,
    Math.round((Date.now() - new Date(cutoverDate).getTime()) / 86400000)
  );
  const dailyRate = totalUsd / daysSinceCutover;
  const projectedMonthly = dailyRate * 30;
  const pctOfCap = (totalUsd / AGENT_SDK_CREDIT_CAP) * 100;

  let finding;
  if (totalUsd === 0) {
    finding = `Since ${cutoverDate}, no API calls recorded yet. Your F1 proxy migration may not be complete.`;
  } else if (projectedMonthly > AGENT_SDK_CREDIT_CAP) {
    finding = `Since ${cutoverDate}: $${totalUsd.toFixed(4)} across ${callCount} calls (${Math.round(totalTokens / 1000)}k tokens). At this rate (~$${projectedMonthly.toFixed(2)}/mo), you would have exceeded the $${AGENT_SDK_CREDIT_CAP} Max 5x Agent SDK credit cap and faced overage charges. F1 gives you visibility + control.`;
  } else {
    finding = `Since ${cutoverDate}: $${totalUsd.toFixed(4)} across ${callCount} calls (${pctOfCap.toFixed(1)}% of the $${AGENT_SDK_CREDIT_CAP} Max 5x Agent SDK credit cap). Projected monthly: ~$${projectedMonthly.toFixed(2)}.`;
  }

  return {
    id: "since_cutover",
    title: "Spend since claude -p cutover (vs Max 5x credit cap)",
    finding,
    estimated_savings_usd: 0,
    detail: {
      cutover_date: cutoverDate,
      total_usd: totalUsd,
      total_tokens: totalTokens,
      call_count: callCount,
      days: daysSinceCutover,
      projected_monthly_usd: parseFloat(projectedMonthly.toFixed(4)),
      agent_sdk_credit_cap: AGENT_SDK_CREDIT_CAP,
    },
  };
}
