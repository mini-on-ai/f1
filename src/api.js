/**
 * api.js — F1 dashboard + billing API routes.
 *
 * All /api/* routes live here. Authentication is via dashboard_token
 * (embedded in URL, hashed in DB). The webhook route is unauthenticated
 * but verified via Stripe HMAC.
 *
 * Routes:
 *   POST /api/checkout                — create Stripe Checkout session
 *   POST /api/webhook/stripe          — Stripe lifecycle events
 *   POST /api/portal                  — Stripe Customer Portal session
 *   POST /api/set-anthropic-key       — upload + encrypt customer Anthropic key
 *   GET  /api/stats                   — 7d/30d spend rollup + model breakdown
 *   GET  /api/keys                    — list API keys
 *   GET  /api/usage                   — paginated raw events
 *   GET  /api/insights                — 5 rule-based optimization insights
 *   GET  /api/key-access-log          — audit log of key usage
 *   GET  /api/alerts                  — fetch alert settings + suggested budget
 *   POST /api/alerts                  — set monthly budget / email / webhook
 *   POST /api/alerts/test             — fire a synthetic alert to verify channels
 *   GET  /api/public-stats            — unauthenticated factory rollup (for landing-page widget)
 *   GET  /api/admin-stats             — MRR + subscriber count (Telegram /f1-stats)
 *   DELETE /api/account               — GDPR: delete all account data
 *   GET  /api/health                  — binding health check
 */

import { encryptApiKey, hashToken, generateToken } from "./crypto.js";
import { runInsights } from "./insights.js";
import { sendBudgetAlertEmail, sendBudgetAlertWebhook } from "./alerts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Route dispatcher (called from index.js)
// ─────────────────────────────────────────────────────────────────────────────

export async function handleApi(request, env, path) {
  if (request.method === "OPTIONS") return corsOk(env);

  const url = new URL(request.url);

  try {
    // Public / webhook routes (no auth)
    if (path === "/api/health" && request.method === "GET") {
      return handleHealth(request, env);
    }
    if (path === "/api/public-stats" && request.method === "GET") {
      return handlePublicStats(request, env);
    }
    if (path === "/api/checkout" && request.method === "POST") {
      return handleCheckout(request, env);
    }
    if (path === "/api/webhook/stripe" && request.method === "POST") {
      return handleStripeWebhook(request, env);
    }

    // Admin route — separate admin token
    if (path === "/api/admin-stats" && request.method === "GET") {
      return handleAdminStats(request, env);
    }

    // Authenticated dashboard routes
    if (path === "/api/portal" && request.method === "POST") {
      return handlePortal(request, env);
    }
    if (path === "/api/set-anthropic-key" && request.method === "POST") {
      return handleSetAnthropicKey(request, env);
    }
    if (path === "/api/stats" && request.method === "GET") {
      return handleStats(request, env);
    }
    if (path === "/api/keys" && request.method === "GET") {
      return handleListKeys(request, env);
    }
    if (path === "/api/usage" && request.method === "GET") {
      return handleUsage(request, env);
    }
    if (path === "/api/insights" && request.method === "GET") {
      return handleInsights(request, env);
    }
    if (path === "/api/key-access-log" && request.method === "GET") {
      return handleKeyAccessLog(request, env);
    }
    if (path === "/api/account" && request.method === "DELETE") {
      return handleDeleteAccount(request, env);
    }
    if (path === "/api/cutover-date" && request.method === "POST") {
      return handleSetCutoverDate(request, env);
    }
    if (path === "/api/prompt-optin" && request.method === "POST") {
      return handleSetPromptOptin(request, env);
    }
    if (path === "/api/alerts" && request.method === "GET") {
      return handleGetAlerts(request, env);
    }
    if (path === "/api/alerts" && request.method === "POST") {
      return handleSetAlerts(request, env);
    }
    if (path === "/api/alerts/test" && request.method === "POST") {
      return handleTestAlert(request, env);
    }

    return corsJson(env, { error: "Not found" }, 404);
  } catch (e) {
    console.error("[api] Unhandled error:", e.message, e.stack);
    return corsJson(env, { error: "Internal server error" }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth helper: resolve account from dashboard token in query string
// ─────────────────────────────────────────────────────────────────────────────

async function requireAccount(request, env) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return null;

  // Token-in-URL: the dashboard token is stored hashed in DB.
  const tokenHash = await hashToken(token);
  const account = await env.DB.prepare(
    "SELECT * FROM accounts WHERE dashboard_token_hash = ?"
  ).bind(tokenHash).first();

  return account || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/checkout — create Stripe Checkout session
// ─────────────────────────────────────────────────────────────────────────────

async function handleCheckout(request, env) {
  const body = await parseJson(request);
  if (body.error) return corsJson(env, body, 400);

  const { email, tier } = body;
  if (!email || !email.includes("@")) {
    return corsJson(env, { error: "Valid email required." }, 400);
  }

  const validTiers = ["pro", "scale"];
  const selectedTier = validTiers.includes(tier) ? tier : "pro";
  const priceId =
    selectedTier === "scale" ? env.STRIPE_PRICE_SCALE : env.STRIPE_PRICE_PRO;

  if (!priceId || priceId.startsWith("REPLACE_")) {
    return corsJson(env, { error: "Stripe price IDs not configured. Contact support." }, 500);
  }

  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "customer_email": email,
    "metadata[email]": email,
    "metadata[tier]": selectedTier,
    "subscription_data[metadata][email]": email,
    "subscription_data[metadata][tier]": selectedTier,
    "success_url": `${env.SITE_URL}/f1?f1=welcome`,
    "cancel_url": `${env.SITE_URL}/f1`,
  });

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10000);
  let stripeRes;
  try {
    stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    console.error("[api] Stripe checkout error:", e.message);
    return corsJson(env, { error: "Payment setup failed. Please try again." }, 500);
  }
  clearTimeout(timeout);

  if (!stripeRes.ok) {
    const err = await stripeRes.text();
    console.error("[api] Stripe checkout response error:", err.slice(0, 200));
    return corsJson(env, { error: "Payment setup failed. Please try again." }, 500);
  }

  const session = await stripeRes.json();
  return corsJson(env, { checkout_url: session.url });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/webhook/stripe
// ─────────────────────────────────────────────────────────────────────────────

async function handleStripeWebhook(request, env) {
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET not configured");
    return new Response("Webhook secret not configured", { status: 500 });
  }
  if (!signature) {
    return new Response("Missing stripe-signature", { status: 400 });
  }

  const isValid = await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    console.error("[webhook] Invalid Stripe signature");
    return new Response("Invalid signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { type, data } = event;
  const obj = data?.object;

  if (type === "checkout.session.completed" && obj?.mode === "subscription") {
    await provisionAccount(env, obj);
  }

  if (type === "customer.subscription.deleted") {
    await env.DB.prepare(
      `UPDATE accounts
       SET stripe_subscription_id = NULL, updated_at = datetime('now')
       WHERE stripe_subscription_id = ?`
    ).bind(obj.id).run();
    // NOTE: We do NOT downgrade tier on deletion — v1 has no enforcement.
    // Future: set tier = 'cancelled' and stop proxying.
  }

  if (type === "invoice.payment_failed") {
    console.warn("[webhook] Payment failed for subscription:", obj?.subscription);
  }

  return new Response("ok", { status: 200 });
}

// ── Account provisioning after successful checkout ────────────────────────

async function provisionAccount(env, session) {
  const email = session.metadata?.email || session.customer_details?.email;
  const tier = session.metadata?.tier || "pro";

  if (!email) {
    console.error("[provision] No email in Stripe session metadata:", session.id);
    return;
  }

  // Idempotent: if account already exists (duplicate webhook), just update Stripe IDs.
  const existing = await env.DB.prepare(
    "SELECT id, dashboard_token_hash FROM accounts WHERE email = ?"
  ).bind(email).first();

  if (existing) {
    await env.DB.prepare(
      `UPDATE accounts
       SET stripe_customer_id = ?,
           stripe_subscription_id = ?,
           tier = ?,
           monthly_token_quota = ?,
           updated_at = datetime('now')
       WHERE email = ?`
    ).bind(
      session.customer,
      session.subscription,
      tier,
      tier === "scale" ? parseInt(env.SCALE_MONTHLY_TOKEN_QUOTA || "25000000") : parseInt(env.PRO_MONTHLY_TOKEN_QUOTA || "1000000"),
      email
    ).run();
    console.log(`[provision] Updated existing account for ${email}`);
    return;
  }

  // Generate tokens — store hashed
  const dashToken = generateToken("f1_dash_");
  const apiKey = generateToken("f1_key_");
  const dashTokenHash = await hashToken(dashToken);
  const apiKeyHash = await hashToken(apiKey);

  const accountId = `f1_acc_${Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join("")}`;
  const apiKeyId = apiKey.slice(0, 20); // display prefix (first 20 chars, no secret)

  const quota = tier === "scale"
    ? parseInt(env.SCALE_MONTHLY_TOKEN_QUOTA || "25000000")
    : parseInt(env.PRO_MONTHLY_TOKEN_QUOTA || "1000000");

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO accounts (id, email, tier, monthly_token_quota, dashboard_token_hash,
                             stripe_customer_id, stripe_subscription_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(accountId, email, tier, quota, dashTokenHash, session.customer, session.subscription),

    env.DB.prepare(
      `INSERT INTO api_keys (id, key_hash, account_id, label)
       VALUES (?, ?, ?, 'Default key')`
    ).bind(apiKeyId, apiKeyHash, accountId),
  ]);

  console.log(`[provision] Created account ${accountId} for ${email} (${tier})`);

  // Send welcome email with API key + dashboard URL
  await sendWelcomeEmail(env, {
    email,
    tier,
    apiKey,       // plaintext — only time it leaves the system
    dashboardUrl: `${env.SITE_URL}/f1/dashboard?token=${dashToken}`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/portal — Stripe Customer Portal
// ─────────────────────────────────────────────────────────────────────────────

async function handlePortal(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);
  if (!account.stripe_customer_id) {
    return corsJson(env, { error: "No active subscription found." }, 400);
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10000);
  let stripeRes;
  try {
    stripeRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        customer: account.stripe_customer_id,
        return_url: `${env.SITE_URL}/f1/dashboard?token=${new URL(request.url).searchParams.get("token")}`,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    return corsJson(env, { error: "Could not open billing portal." }, 500);
  }
  clearTimeout(timeout);

  if (!stripeRes.ok) {
    return corsJson(env, { error: "Could not open billing portal." }, 500);
  }

  const session = await stripeRes.json();
  return corsJson(env, { portal_url: session.url });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/set-anthropic-key — BYOK: upload + encrypt customer Anthropic key
// ─────────────────────────────────────────────────────────────────────────────

async function handleSetAnthropicKey(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const body = await parseJson(request);
  if (body.error) return corsJson(env, body, 400);

  const { anthropic_key } = body;
  if (!anthropic_key || !anthropic_key.startsWith("sk-ant-")) {
    return corsJson(env, { error: "Invalid Anthropic API key. Must start with sk-ant-." }, 400);
  }

  if (!env.F1_KEY_ENCRYPTION_MASTER) {
    console.error("[api] F1_KEY_ENCRYPTION_MASTER not configured");
    return corsJson(env, { error: "Server configuration error. Contact support." }, 500);
  }

  const { ciphertext, iv, salt } = await encryptApiKey(anthropic_key, env.F1_KEY_ENCRYPTION_MASTER);

  await env.DB.prepare(
    `UPDATE accounts
     SET anthropic_key_ciphertext = ?,
         anthropic_key_iv = ?,
         anthropic_key_salt = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).bind(ciphertext, iv, salt, account.id).run();

  // Invalidate KV caches for all keys on this account (they cache the old encrypted blobs)
  const { results: keys } = await env.DB.prepare(
    "SELECT key_hash FROM api_keys WHERE account_id = ? AND revoked_at IS NULL"
  ).bind(account.id).all();

  for (const k of keys) {
    try { await env.KV.delete(`key:${k.key_hash}`); } catch (_) {}
  }

  // Audit log
  await env.DB.prepare(
    "INSERT INTO key_access_log (account_id, reason) VALUES (?, 'key_rotation')"
  ).bind(account.id).run();

  return corsJson(env, { ok: true, message: "Anthropic API key saved and encrypted." });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stats
// ─────────────────────────────────────────────────────────────────────────────

async function handleStats(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const [today, week, month, byModel] = await Promise.all([
    env.DB.prepare(
      `SELECT SUM(usd_cost) as usd, SUM(input_tokens+output_tokens) as tokens, COUNT(*) as calls
       FROM usage_events WHERE account_id = ? AND ts >= datetime('now', 'start of day')`
    ).bind(account.id).first(),

    env.DB.prepare(
      `SELECT SUM(usd_cost) as usd, SUM(input_tokens+output_tokens) as tokens, COUNT(*) as calls
       FROM usage_events WHERE account_id = ? AND ts >= datetime('now', '-7 days')`
    ).bind(account.id).first(),

    env.DB.prepare(
      `SELECT SUM(usd_cost) as usd, SUM(input_tokens+output_tokens) as tokens, COUNT(*) as calls
       FROM usage_events WHERE account_id = ? AND ts >= datetime('now', '-30 days')`
    ).bind(account.id).first(),

    env.DB.prepare(
      `SELECT model, SUM(usd_cost) as usd, SUM(input_tokens) as input_tok, SUM(output_tokens) as output_tok, COUNT(*) as calls
       FROM usage_events WHERE account_id = ? AND ts >= datetime('now', '-30 days')
       GROUP BY model ORDER BY usd DESC`
    ).bind(account.id).all(),
  ]);

  return corsJson(env, {
    account: {
      tier: account.tier,
      email: account.email,
      has_anthropic_key: !!account.anthropic_key_ciphertext,
    },
    today: { usd: today?.usd ?? 0, tokens: today?.tokens ?? 0, calls: today?.calls ?? 0 },
    week: { usd: week?.usd ?? 0, tokens: week?.tokens ?? 0, calls: week?.calls ?? 0 },
    month: { usd: month?.usd ?? 0, tokens: month?.tokens ?? 0, calls: month?.calls ?? 0 },
    by_model: byModel.results ?? [],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/keys
// ─────────────────────────────────────────────────────────────────────────────

async function handleListKeys(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const { results } = await env.DB.prepare(
    `SELECT id, label, revoked_at, created_at FROM api_keys WHERE account_id = ? ORDER BY created_at DESC`
  ).bind(account.id).all();

  return corsJson(env, {
    keys: results.map((k) => ({
      id: k.id,            // display prefix only (not the full hash)
      label: k.label,
      active: !k.revoked_at,
      created_at: k.created_at,
    })),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/usage?since=...&limit=100
// ─────────────────────────────────────────────────────────────────────────────

async function handleUsage(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const url = new URL(request.url);
  const since = url.searchParams.get("since") || new Date(Date.now() - 7 * 86400000).toISOString();
  const limit = Math.min(500, parseInt(url.searchParams.get("limit") || "100", 10));

  const { results } = await env.DB.prepare(
    `SELECT ts, model, input_tokens, output_tokens,
            cache_creation_input_tokens, cache_read_input_tokens,
            usd_cost, status_code, latency_ms
     FROM usage_events
     WHERE account_id = ? AND ts >= ?
     ORDER BY ts DESC
     LIMIT ?`
  ).bind(account.id, since, limit).all();

  return corsJson(env, { events: results, count: results.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/insights
// ─────────────────────────────────────────────────────────────────────────────

async function handleInsights(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const insights = await runInsights(env, account.id, account.cutover_date);
  return corsJson(env, { insights });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/key-access-log
// ─────────────────────────────────────────────────────────────────────────────

async function handleKeyAccessLog(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const { results } = await env.DB.prepare(
    `SELECT ts, reason, ip_hash FROM key_access_log
     WHERE account_id = ? ORDER BY ts DESC LIMIT 100`
  ).bind(account.id).all();

  return corsJson(env, { log: results });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cutover-date
// ─────────────────────────────────────────────────────────────────────────────

async function handleSetCutoverDate(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const body = await parseJson(request);
  if (body.error) return corsJson(env, body, 400);

  const { cutover_date } = body;
  if (!cutover_date || !/^\d{4}-\d{2}-\d{2}$/.test(cutover_date)) {
    return corsJson(env, { error: "cutover_date must be YYYY-MM-DD." }, 400);
  }

  await env.DB.prepare(
    "UPDATE accounts SET cutover_date = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(cutover_date, account.id).run();

  return corsJson(env, { ok: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/prompt-optin — toggle prompt-prefix storage (off by default)
// ─────────────────────────────────────────────────────────────────────────────

async function handleSetPromptOptin(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const body = await parseJson(request);
  if (body.error) return corsJson(env, body, 400);

  const { prompt_optin } = body;
  const val = prompt_optin === 1 || prompt_optin === true ? 1 : 0;

  await env.DB.prepare(
    "UPDATE accounts SET prompt_storage_optin = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(val, account.id).run();

  // Invalidate KV cache so the proxy hot path re-reads the flag.
  // The key meta cache uses key_hash; we don't have it here, but the TTL is 5min
  // so the change will propagate at most 5min later for in-flight cached keys.
  return corsJson(env, { ok: true, prompt_storage_optin: val });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/alerts — fetch current alert settings + suggested budget
// POST /api/alerts — update alert settings
// POST /api/alerts/test — fire a synthetic alert to verify channels
// ─────────────────────────────────────────────────────────────────────────────

async function handleGetAlerts(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  // Rolling 30-day spend for the personalized-suggestion default.
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(usd_cost), 0) AS spent_30d
     FROM usage_events
     WHERE account_id = ?
       AND ts >= datetime('now', '-30 days')`
  ).bind(account.id).first();

  const spent30d = Number(row?.spent_30d || 0);
  // suggested = max($50, ceil(1.5 * spent_30d / 10) * 10)
  const raw = 1.5 * spent30d;
  const suggested = Math.max(50, Math.ceil(raw / 10) * 10);

  return corsJson(env, {
    alert_budget_usd: account.alert_budget_usd,
    alert_email: account.alert_email,
    alert_webhook_url: account.alert_webhook_url,
    alert_fired_at: account.alert_fired_at,
    alert_fired_month: account.alert_fired_month,
    suggested_budget_usd: suggested,
    spent_last_30d_usd: Number(spent30d.toFixed(2)),
    account_email: account.email,
  });
}

async function handleSetAlerts(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const body = await parseJson(request);
  if (body.error) return corsJson(env, body, 400);

  // Validate budget
  let budget = null;
  if (body.alert_budget_usd !== null && body.alert_budget_usd !== undefined && body.alert_budget_usd !== "") {
    const n = Number(body.alert_budget_usd);
    if (!Number.isFinite(n) || n <= 0) {
      return corsJson(env, { error: "alert_budget_usd must be a positive number or null." }, 400);
    }
    budget = n;
  }

  // Validate email (optional override)
  let alertEmail = null;
  if (body.alert_email && typeof body.alert_email === "string" && body.alert_email.trim()) {
    const e = body.alert_email.trim();
    if (!e.includes("@") || e.length > 254) {
      return corsJson(env, { error: "alert_email is not a valid address." }, 400);
    }
    alertEmail = e;
  }

  // Validate webhook URL (optional)
  let webhookUrl = null;
  let webhookWarning = null;
  if (body.alert_webhook_url && typeof body.alert_webhook_url === "string" && body.alert_webhook_url.trim()) {
    const u = body.alert_webhook_url.trim();
    if (!u.startsWith("https://")) {
      return corsJson(env, { error: "alert_webhook_url must be https://." }, 400);
    }
    if (u.length > 500) {
      return corsJson(env, { error: "alert_webhook_url is too long." }, 400);
    }
    webhookUrl = u;
    const isSlack = u.startsWith("https://hooks.slack.com/");
    const isDiscord = u.startsWith("https://discord.com/api/webhooks/") || u.startsWith("https://discordapp.com/api/webhooks/");
    if (!isSlack && !isDiscord) {
      webhookWarning = "URL does not match Slack or Discord webhook patterns. Saved anyway — verify with the Send test alert button.";
    }
    if (isDiscord && !u.endsWith("/slack")) {
      webhookWarning = "Discord webhook URLs must end with /slack for our Slack-format payload. Append /slack and save again.";
    }
  }

  // Changing the budget re-arms the alert for this month.
  await env.DB.prepare(
    `UPDATE accounts
     SET alert_budget_usd = ?,
         alert_email = ?,
         alert_webhook_url = ?,
         alert_fired_month = NULL,
         alert_fired_at = NULL,
         updated_at = datetime('now')
     WHERE id = ?`
  ).bind(budget, alertEmail, webhookUrl, account.id).run();

  return corsJson(env, {
    ok: true,
    alert_budget_usd: budget,
    alert_email: alertEmail,
    alert_webhook_url: webhookUrl,
    warning: webhookWarning,
  });
}

async function handleTestAlert(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  const dashboardUrl = `${env.SITE_URL || "https://mini-on-ai.com"}/f1/dashboard`;
  const to = account.alert_email || account.email;
  const mtdSpend = 42.0;
  const threshold = 50.0;

  const results = { email: false, webhook: null };

  try {
    results.email = await sendBudgetAlertEmail(env, { to, mtdSpend, threshold, dashboardUrl });
  } catch (e) {
    console.error("[api] test alert email error:", e.message);
    results.email = false;
  }

  if (account.alert_webhook_url) {
    try {
      results.webhook = await sendBudgetAlertWebhook(env, {
        url: account.alert_webhook_url,
        mtdSpend,
        threshold,
        accountId: account.id,
        dashboardUrl,
      });
    } catch (e) {
      console.error("[api] test alert webhook error:", e.message);
      results.webhook = false;
    }
  }

  return corsJson(env, {
    ok: true,
    sent: results,
    note: "Synthetic alert (MTD $42, threshold $50). Does not affect your real fired-once-per-month state.",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/public-stats — unauthenticated factory rollup (landing-page widget)
// ─────────────────────────────────────────────────────────────────────────────

async function handlePublicStats(request, env) {
  // Identify the factory account by its dashboard token (stored as env secret)
  if (!env.F1_FACTORY_DASHBOARD_TOKEN) {
    return corsJson(env, { error: "Public stats not configured." }, 404);
  }

  const factoryTokenHash = await hashToken(env.F1_FACTORY_DASHBOARD_TOKEN);
  const factoryAccount = await env.DB.prepare(
    "SELECT id FROM accounts WHERE dashboard_token_hash = ?"
  ).bind(factoryTokenHash).first();

  if (!factoryAccount) {
    return corsJson(env, { error: "Factory account not found." }, 404);
  }

  const [month, allTime] = await Promise.all([
    env.DB.prepare(
      `SELECT SUM(usd_cost) as usd, SUM(input_tokens+output_tokens) as tokens, COUNT(*) as calls
       FROM usage_events WHERE account_id = ? AND ts >= datetime('now', '-30 days')`
    ).bind(factoryAccount.id).first(),

    env.DB.prepare(
      `SELECT SUM(usd_cost) as usd, SUM(input_tokens+output_tokens) as tokens, COUNT(*) as calls
       FROM usage_events WHERE account_id = ?`
    ).bind(factoryAccount.id).first(),
  ]);

  return corsJson(env, {
    label: "mini-on-factory (dogfooded)",
    last_30_days: {
      usd: month?.usd ?? 0,
      tokens: month?.tokens ?? 0,
      calls: month?.calls ?? 0,
    },
    all_time: {
      usd: allTime?.usd ?? 0,
      tokens: allTime?.tokens ?? 0,
      calls: allTime?.calls ?? 0,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin-stats — for Telegram /f1-stats command
// ─────────────────────────────────────────────────────────────────────────────

async function handleAdminStats(request, env) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token || token !== env.F1_ADMIN_TOKEN) {
    return corsJson(env, { error: "Unauthorized." }, 401);
  }

  const [today, month, subs] = await Promise.all([
    env.DB.prepare(
      `SELECT SUM(usd_cost) as usd, COUNT(*) as calls
       FROM usage_events WHERE ts >= datetime('now', 'start of day')`
    ).first(),

    env.DB.prepare(
      `SELECT SUM(usd_cost) as usd, COUNT(*) as calls
       FROM usage_events WHERE ts >= datetime('now', '-30 days')`
    ).first(),

    env.DB.prepare(
      `SELECT tier, COUNT(*) as n FROM accounts
       WHERE stripe_subscription_id IS NOT NULL
       GROUP BY tier`
    ).all(),
  ]);

  // MRR: count active subs × tier price
  let mrr = 0;
  for (const row of subs.results ?? []) {
    mrr += row.n * (row.tier === "scale" ? 99 : 19);
  }

  const totalSubs = (subs.results ?? []).reduce((s, r) => s + r.n, 0);

  return corsJson(env, {
    today_usd: today?.usd ?? 0,
    today_calls: today?.calls ?? 0,
    month_usd: month?.usd ?? 0,
    month_calls: month?.calls ?? 0,
    mrr,
    subscribers: totalSubs,
    by_tier: subs.results ?? [],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/account — GDPR: delete all account data
// ─────────────────────────────────────────────────────────────────────────────

async function handleDeleteAccount(request, env) {
  const account = await requireAccount(request, env);
  if (!account) return corsJson(env, { error: "Invalid or missing dashboard token." }, 401);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM key_access_log WHERE account_id = ?").bind(account.id),
    env.DB.prepare("DELETE FROM usage_events WHERE account_id = ?").bind(account.id),
    env.DB.prepare("DELETE FROM api_keys WHERE account_id = ?").bind(account.id),
    env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id),
  ]);

  return corsJson(env, { deleted: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────────────────────────────────────

async function handleHealth(request, env) {
  const checks = {};
  try { await env.DB.prepare("SELECT 1").first(); checks.db = "ok"; }
  catch (e) { checks.db = "FAIL: " + e.message; }
  try { await env.KV.get("__health__"); checks.kv = "ok"; }
  catch (e) { checks.kv = "FAIL: " + e.message; }
  checks.stripe_key = env.STRIPE_SECRET_KEY ? "set" : "MISSING";
  checks.encryption_master = env.F1_KEY_ENCRYPTION_MASTER ? "set" : "MISSING";
  checks.brevo_key = env.BREVO_API_KEY ? "set" : "MISSING";
  return corsJson(env, checks);
}

// ─────────────────────────────────────────────────────────────────────────────
// Brevo: send welcome email
// ─────────────────────────────────────────────────────────────────────────────

async function sendWelcomeEmail(env, { email, tier, apiKey, dashboardUrl }) {
  if (!env.BREVO_API_KEY) {
    console.warn("[email] BREVO_API_KEY not set — skipping welcome email for", email);
    return;
  }

  const tierLabel = tier === "scale" ? "Scale ($99/mo)" : "Pro ($19/mo)";

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Inter,system-ui,sans-serif;background:#08080F;color:#e2e8f0;max-width:560px;margin:0 auto;padding:32px 24px;">
  <h1 style="color:#6366F1;font-size:24px;margin-bottom:8px;">Welcome to F1</h1>
  <p style="color:#94a3b8;margin-bottom:24px;">Your AI cost-tracking proxy is ready. Here's everything you need.</p>

  <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#6366F1;">Your Plan</h2>
  <p>${tierLabel}</p>

  <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#6366F1;">Your F1 API Key</h2>
  <p style="background:#1e293b;padding:12px 16px;border-radius:8px;font-family:monospace;font-size:13px;word-break:break-all;">${apiKey}</p>
  <p style="color:#94a3b8;font-size:13px;">Keep this secret. Use it in place of your Anthropic key when calling F1.</p>

  <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#6366F1;">Your Dashboard</h2>
  <p><a href="${dashboardUrl}" style="color:#6366F1;">${dashboardUrl}</a></p>
  <p style="color:#94a3b8;font-size:13px;">Bookmark this link — it's your key-access log, spend insights, and billing portal. No password required.</p>
  <p style="color:#94a3b8;font-size:13px;"><strong style="color:#e2e8f0;">Tip:</strong> set a monthly budget on your dashboard (Settings tab) and we'll email you the moment your Anthropic spend crosses it. Free on every tier.</p>

  <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#6366F1;">Next Step: Upload Your Anthropic Key</h2>
  <p style="color:#94a3b8;font-size:13px;">Your Anthropic API key is needed so F1 can proxy your calls. Paste it on your dashboard, or send it via:</p>
  <pre style="background:#1e293b;padding:12px 16px;border-radius:8px;font-size:12px;overflow-x:auto;">curl -X POST https://f1-api.kirozdormu.workers.dev/api/set-anthropic-key?token=YOUR_DASHBOARD_TOKEN \\
  -H "Content-Type: application/json" \\
  -d '{"anthropic_key": "sk-ant-..."}'</pre>

  <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#6366F1;">Point Your SDK at F1</h2>
  <pre style="background:#1e293b;padding:12px 16px;border-radius:8px;font-size:12px;overflow-x:auto;"># Python
import anthropic
client = anthropic.Anthropic(
    base_url="https://f1-api.kirozdormu.workers.dev/v1",
    api_key="${apiKey.slice(0, 16)}..."
)</pre>

  <hr style="border:none;border-top:1px solid #1e293b;margin:32px 0;">
  <p style="color:#475569;font-size:12px;">
    You're receiving this because you signed up at mini-on-ai.com.<br>
    Questions? Reply to this email.<br>
    <a href="${env.SITE_URL}/f1/security" style="color:#6366F1;">Security &amp; Privacy</a>
  </p>
</body>
</html>`;

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: env.BREVO_SENDER_NAME || "mini-on-ai", email: env.BREVO_SENDER_EMAIL || "hello@mini-on-ai.com" },
        to: [{ email }],
        subject: "Your F1 API key + dashboard",
        htmlContent: htmlBody,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[email] Brevo send failed:", err.slice(0, 200));
    } else {
      console.log(`[email] Welcome email sent to ${email}`);
    }
  } catch (e) {
    console.error("[email] Brevo fetch error:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook signature verification (HMAC-SHA256)
// Copied from clauseguard/worker/src/billing.js
// ─────────────────────────────────────────────────────────────────────────────

async function verifyStripeSignature(payload, signatureHeader, secret) {
  try {
    const parts = signatureHeader.split(",").reduce((acc, part) => {
      const [key, value] = part.split("=");
      acc[key.trim()] = value;
      return acc;
    }, {});

    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) return false;

    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
    if (age > 300) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const expected = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return expected === signature;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

export function corsJson(env, obj, status = 200) {
  const origin = env?.ALLOWED_ORIGIN || "https://mini-on-ai.com";
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
    },
  });
}

export function corsOk(env) {
  const origin = env?.ALLOWED_ORIGIN || "https://mini-on-ai.com";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    },
  });
}

export async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return { error: "Invalid JSON body" };
  }
}
