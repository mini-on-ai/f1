-- F1 schema — BYOK Anthropic cost-tracking proxy.
-- See f1/worker/README.md for the no-prompt-bodies-in-storage invariant.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                              -- f1_acc_<32 hex>
  email TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'pro',                 -- 'pro' | 'scale'
  monthly_token_quota INTEGER NOT NULL,             -- informational in v1 (no enforcement)

  -- Dashboard access: token-in-URL only. Stored hashed; constant-time compared.
  dashboard_token_hash TEXT NOT NULL,

  -- Stripe linkage
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,

  -- BYOK: customer's Anthropic key, encrypted at rest with AES-GCM.
  -- All three columns are NULL until the customer uploads their key.
  anthropic_key_ciphertext BLOB,
  anthropic_key_iv BLOB,
  anthropic_key_salt BLOB,

  -- Prompt-body storage opt-in. Off by default. When on, usage_events.prompt_prefix
  -- may store up to 200 chars; full bodies are never persisted.
  prompt_storage_optin INTEGER NOT NULL DEFAULT 0,  -- 0 | 1

  -- Cutover date for the "since cutover" insight (NULL if not opted in).
  cutover_date TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Customer-facing F1 API keys. Stored hashed (SHA-256). Constant-time compared.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,                              -- f1_key_<prefix>; first 12 chars of the plaintext key for UI display
  key_hash TEXT NOT NULL UNIQUE,                    -- SHA-256 of the full plaintext key
  account_id TEXT NOT NULL REFERENCES accounts(id),
  label TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_api_keys_account ON api_keys(account_id);

-- One row per proxied API call. NO prompt or response bodies.
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
  usd_cost REAL NOT NULL DEFAULT 0,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER,

  -- Optional: only populated when accounts.prompt_storage_optin = 1. Max 200 chars.
  prompt_prefix TEXT,

  -- SHA-256 of first 2k chars of input. Populated only when prompt_storage_optin = 1.
  -- Reveals only repetition shape (which prompts repeat), not content. Gated behind opt-in.
  input_hash TEXT
);

CREATE INDEX idx_usage_account_ts ON usage_events(account_id, ts);
CREATE INDEX idx_usage_account_hash ON usage_events(account_id, input_hash);

-- Audit log: every decryption of the customer's Anthropic key.
-- Customer-readable via /api/key-access-log.
CREATE TABLE key_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT NOT NULL,                             -- 'proxy_forward' | 'admin_audit' | 'key_rotation'
  ip_hash TEXT                                       -- truncated SHA-256(client_ip + daily_salt) — not raw IP
);

CREATE INDEX idx_key_access_account_ts ON key_access_log(account_id, ts);
