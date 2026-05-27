-- F1 v2 schema migration: spend alerts.
-- Adds opt-in monthly budget alerts to accounts. Free on every tier.
-- See: dashboard "Spend alerts" section, /api/alerts endpoints, src/alerts.js.

ALTER TABLE accounts ADD COLUMN alert_budget_usd REAL;          -- NULL = alerts off
ALTER TABLE accounts ADD COLUMN alert_email TEXT;               -- NULL = use accounts.email
ALTER TABLE accounts ADD COLUMN alert_webhook_url TEXT;         -- NULL = no webhook
ALTER TABLE accounts ADD COLUMN alert_fired_at TEXT;            -- ISO datetime of last fire; NULL = never
ALTER TABLE accounts ADD COLUMN alert_fired_month TEXT;         -- 'YYYY-MM' of last fire; once-per-month guard
