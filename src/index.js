/**
 * F1 — AI Cost Tracking Proxy
 * Cloudflare Worker entrypoint
 *
 * Routes:
 *   /v1/*   → Anthropic API proxy (authenticated via F1 API key)
 *   /api/*  → Dashboard, billing, BYOK key management
 *
 * Environment bindings:
 *   DB                         — D1 database
 *   KV                         — KV namespace (hot-path key cache + rate limiting)
 *   STRIPE_SECRET_KEY          — secret
 *   STRIPE_WEBHOOK_SECRET      — secret
 *   BREVO_API_KEY              — secret
 *   F1_KEY_ENCRYPTION_MASTER   — secret (base64-encoded 32+ bytes)
 *   F1_ADMIN_TOKEN             — secret (for /api/admin-stats)
 *   F1_FACTORY_DASHBOARD_TOKEN — secret (identifies factory account in public-stats)
 *   ALLOWED_ORIGIN             — var (default: https://mini-on-ai.com)
 *   SITE_URL                   — var
 *   STRIPE_PRICE_PRO           — var
 *   STRIPE_PRICE_SCALE         — var
 */

import { handleProxy } from "./proxy.js";
import { handleApi, corsOk, corsJson } from "./api.js";

export default {
  async fetch(request, env, ctx) {
    // CORS preflight — handle before routing so browsers get the right headers
    if (request.method === "OPTIONS") return corsOk(env);

    const url = new URL(request.url);
    const path = url.pathname;

    // ── Anthropic API proxy: forward /v1/* to Anthropic ─────────────────────
    if (path.startsWith("/v1/")) {
      return handleProxy(request, env, ctx, path);
    }

    // ── F1 API: dashboard + billing + BYOK ──────────────────────────────────
    if (path.startsWith("/api/")) {
      return handleApi(request, env, path);
    }

    // ── Root: minimal info page ──────────────────────────────────────────────
    if (path === "/" || path === "") {
      return new Response(
        JSON.stringify({
          name: "F1 — AI Cost Tracking Proxy",
          docs: "https://mini-on-ai.com/f1",
          health: "/api/health",
          proxy: "/v1/messages",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "https://mini-on-ai.com",
          },
        }
      );
    }

    return corsJson(env, { error: "Not found" }, 404);
  },
};
