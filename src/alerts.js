/**
 * alerts.js — F1 monthly-budget spend alerts.
 *
 * One alert type in v1: month-to-date (MTD) spend >= alert_budget_usd.
 * Channels: email (Brevo) + optional webhook (Slack-format payload; Discord
 * users append `/slack` to their webhook URL).
 *
 * Trigger: called from proxy.js after recordUsageEvent() resolves, inside the
 * existing ctx.waitUntil() block. Idempotence is enforced by accounts.alert_fired_month
 * (only one fire per calendar month per account).
 *
 * Public exports:
 *   - checkAndFireBudgetAlert(env, accountId) → void
 *   - sendBudgetAlertEmail(env, args)         → boolean
 *   - sendBudgetAlertWebhook(env, args)       → boolean
 */

// ─────────────────────────────────────────────────────────────────────────────
// Trigger: called from proxy.js after each successful recordUsageEvent
// ─────────────────────────────────────────────────────────────────────────────

export async function checkAndFireBudgetAlert(env, accountId) {
  try {
    const account = await env.DB.prepare(
      `SELECT id, email, alert_budget_usd, alert_email, alert_webhook_url,
              alert_fired_month, dashboard_token_hash
       FROM accounts WHERE id = ?`
    ).bind(accountId).first();

    if (!account) return;
    if (account.alert_budget_usd == null) return; // alerts disabled

    // Idempotence: once-per-calendar-month.
    const currentMonth = await currentYearMonth(env);
    if (account.alert_fired_month === currentMonth) return;

    // MTD spend = SUM(usd_cost) from the 1st of this month, UTC.
    const row = await env.DB.prepare(
      `SELECT COALESCE(SUM(usd_cost), 0) AS mtd
       FROM usage_events
       WHERE account_id = ?
         AND ts >= strftime('%Y-%m-01 00:00:00', 'now')`
    ).bind(accountId).first();

    const mtdSpend = Number(row?.mtd || 0);
    const threshold = Number(account.alert_budget_usd);
    if (mtdSpend < threshold) return;

    // Mark fired BEFORE sending — if sends fail, we don't spam the user on
    // every subsequent call. They can re-arm by clicking Save in the dashboard.
    await env.DB.prepare(
      `UPDATE accounts
       SET alert_fired_at = datetime('now'),
           alert_fired_month = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).bind(currentMonth, accountId).run();

    const dashboardUrl = `${env.SITE_URL || "https://mini-on-ai.com"}/f1/dashboard`;
    const to = account.alert_email || account.email;

    // Fire both channels in parallel; isolate failures.
    const tasks = [
      sendBudgetAlertEmail(env, { to, mtdSpend, threshold, dashboardUrl }).catch((e) =>
        console.error("[alerts] email send failed:", e.message)
      ),
    ];
    if (account.alert_webhook_url) {
      tasks.push(
        sendBudgetAlertWebhook(env, {
          url: account.alert_webhook_url,
          mtdSpend,
          threshold,
          accountId,
          dashboardUrl,
        }).catch((e) => console.error("[alerts] webhook send failed:", e.message))
      );
    }
    await Promise.all(tasks);
  } catch (e) {
    // Never let alerting break the hot path.
    console.error("[alerts] checkAndFireBudgetAlert error:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Email: Brevo transactional /smtp/email
// ─────────────────────────────────────────────────────────────────────────────

export async function sendBudgetAlertEmail(env, { to, mtdSpend, threshold, dashboardUrl }) {
  if (!env.BREVO_API_KEY) {
    console.warn("[alerts] BREVO_API_KEY not set — skipping alert email for", to);
    return false;
  }

  const mtd = formatUsd(mtdSpend);
  const thr = formatUsd(threshold);
  const subject = `F1 alert: $${thr} budget crossed (${mtd} MTD)`;

  const htmlBody = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Inter,system-ui,sans-serif;background:#08080F;color:#e2e8f0;max-width:560px;margin:0 auto;padding:32px 24px;">
  <h1 style="color:#6366F1;font-size:22px;margin-bottom:8px;">Budget crossed</h1>
  <p style="color:#94a3b8;margin-bottom:24px;">Your month-to-date Anthropic spend just crossed the threshold you set.</p>

  <div style="background:#1e293b;padding:16px 20px;border-radius:8px;margin-bottom:24px;">
    <p style="margin:0;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;">Spent this month</p>
    <p style="margin:4px 0 12px 0;font-size:28px;font-weight:700;color:#fff;">$${mtd}</p>
    <p style="margin:0;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:.06em;">Your threshold</p>
    <p style="margin:4px 0 0 0;font-size:18px;color:#fff;">$${thr}</p>
  </div>

  <p style="margin-bottom:8px;"><a href="${dashboardUrl}" style="background:#6366F1;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block;">View dashboard →</a></p>

  <p style="color:#94a3b8;font-size:13px;margin-top:24px;">This is a one-time alert for this calendar month. To re-arm or change the threshold, open your dashboard.</p>

  <hr style="border:none;border-top:1px solid #1e293b;margin:32px 0;">
  <p style="color:#475569;font-size:12px;">
    F1 — mini-on-ai.com<br>
    Don't want these? Set your monthly budget to blank on the dashboard.
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
        sender: {
          name: env.BREVO_SENDER_NAME || "mini-on-ai",
          email: env.BREVO_SENDER_EMAIL || "hello@mini-on-ai.com",
        },
        to: [{ email: to }],
        subject,
        htmlContent: htmlBody,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[alerts] Brevo send failed:", err.slice(0, 200));
      return false;
    }
    console.log(`[alerts] Email alert sent to ${to} (mtd=$${mtd}, threshold=$${thr})`);
    return true;
  } catch (e) {
    console.error("[alerts] Brevo fetch error:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook: Slack-format payload (Discord accepts via /slack suffix)
// ─────────────────────────────────────────────────────────────────────────────

export async function sendBudgetAlertWebhook(env, { url, mtdSpend, threshold, accountId, dashboardUrl }) {
  const mtd = formatUsd(mtdSpend);
  const thr = formatUsd(threshold);

  // Slack incoming-webhook payload. Discord supports this when the URL ends
  // with `/slack`. We include both `text` (Slack) and `content` (Discord raw)
  // for maximum compatibility — unknown fields are ignored by each service.
  const payload = {
    text: `*F1 budget crossed* — $${mtd} spent this month (threshold $${thr}). <${dashboardUrl}|View dashboard>`,
    content: `**F1 budget crossed** — $${mtd} spent this month (threshold $${thr}). ${dashboardUrl}`,
    attachments: [
      {
        color: "#6366F1",
        fields: [
          { title: "Spent this month", value: `$${mtd}`, short: true },
          { title: "Threshold", value: `$${thr}`, short: true },
        ],
        footer: "F1 — mini-on-ai.com",
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[alerts] webhook send failed (${res.status}):`, err.slice(0, 200));
      return false;
    }
    console.log(`[alerts] Webhook alert sent (account=${accountId}, mtd=$${mtd}, threshold=$${thr})`);
    return true;
  } catch (e) {
    console.error("[alerts] webhook fetch error:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return "0.00";
  if (v < 0.001) return v.toFixed(6);
  if (v < 0.10)  return v.toFixed(4);
  return v.toFixed(2);
}

async function currentYearMonth(env) {
  const row = await env.DB.prepare("SELECT strftime('%Y-%m', 'now') AS ym").first();
  return row?.ym || new Date().toISOString().slice(0, 7);
}
