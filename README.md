# F1 — AI Cost Tracking Proxy

**F1** is a lightweight Cloudflare Worker that sits in front of the Anthropic API. It authenticates requests with a per-account F1 key, forwards them transparently, and records token usage + USD cost to a D1 database. The dashboard shows spend breakdowns, optimization insights, and an audit log of every time your Anthropic key was used.

→ **[Product page & sign-up](https://mini-on-ai.com/f1)**  
→ **[Security commitments](https://mini-on-ai.com/f1/security)**

## How it works

```
Your app  ──Bearer f1_key_...──▶  F1 Worker  ──Bearer sk-ant-...──▶  api.anthropic.com
                                       │
                                       └── records tokens + USD to D1 (never the prompt body)
```

Your Anthropic API key is held encrypted at rest (AES-GCM, HKDF-derived per-account key). F1 is BYOK: you continue paying Anthropic directly; F1 charges a flat monthly fee for observability.

## No-prompt-bodies policy

**F1 never stores prompt or response content.** `usage_events` records: timestamp, model, token counts, USD cost, HTTP status, latency. The `prompt_prefix` column is NULL by default and only populated (max 200 chars) when the account explicitly opts in.

`console.log` calls in this codebase must not print request or response bodies, the decrypted Anthropic key, or any PII. Reviewers: grep for body/prompt leakage before approving PRs.

```bash
# Quick check — should return nothing suspicious
grep -n "console.log" src/*.js
```

## Deployment

### Prerequisites

- Cloudflare account with Workers + D1 + KV access
- `wrangler` CLI (`npm install -g wrangler`)
- Stripe account (create two Products: Pro $19/mo, Scale $99/mo)
- Brevo account for transactional email

### 1. Create infrastructure

```bash
# D1 database
wrangler d1 create f1
# → copy the database_id into wrangler.toml

# KV namespace
wrangler kv:namespace create F1_KEYS
# → copy the id into wrangler.toml
```

### 2. Apply migrations

```bash
# Local dev
npm run db:migrate:local

# Production
npm run db:migrate:remote
```

### 3. Set secrets

```bash
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put BREVO_API_KEY
wrangler secret put F1_ADMIN_TOKEN          # random string for /api/admin-stats
wrangler secret put F1_FACTORY_DASHBOARD_TOKEN  # dashboard token of your own factory account

# Generate a 32-byte random master key and base64-encode it:
# openssl rand -base64 32 | wrangler secret put F1_KEY_ENCRYPTION_MASTER
wrangler secret put F1_KEY_ENCRYPTION_MASTER
```

### 4. Update wrangler.toml vars

Set `STRIPE_PRICE_PRO` and `STRIPE_PRICE_SCALE` to your actual Stripe Price IDs.

### 5. Deploy

```bash
npm run deploy
```

### 6. Configure Stripe webhook

In the Stripe dashboard, add a webhook pointing at:
```
https://f1-api.kirozdormu.workers.dev/api/webhook/stripe
```
Events to send: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`

Copy the signing secret → `wrangler secret put STRIPE_WEBHOOK_SECRET`

## Local development

```bash
# Copy and fill in your local secrets
cp .dev.vars.example .dev.vars  # edit this file — never commit it

npm run dev
# → http://localhost:8787
```

## Project structure

```
f1/worker/
├── src/
│   ├── index.js      — routing entrypoint (/v1/* → proxy, /api/* → api)
│   ├── proxy.js      — hot-path Anthropic proxy + usage capture
│   ├── api.js        — dashboard routes, Stripe billing, BYOK key upload
│   ├── insights.js   — 5 rule-based optimization insights (SQL only)
│   ├── pricing.js    — model price table + computeCost()
│   └── crypto.js     — AES-GCM key encryption, token hashing
├── migrations/
│   └── 0001_init.sql — D1 schema
├── wrangler.toml
├── package.json
├── LICENSE           — MIT
└── README.md         — this file
```

## SDK integration

### Python (Anthropic SDK)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="https://f1-api.kirozdormu.workers.dev/v1",
    api_key="f1_key_YOUR_KEY_HERE",
)
# All other calls work exactly as before
response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
```

### Node.js (Anthropic SDK)

```javascript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://f1-api.kirozdormu.workers.dev/v1",
  apiKey: "f1_key_YOUR_KEY_HERE",
});
```

## Security

See [mini-on-ai.com/f1/security](https://mini-on-ai.com/f1/security) for the full security commitments page.

Key points:
- Customer Anthropic keys encrypted at rest (AES-GCM, per-account HKDF-derived key)
- No prompt or response bodies stored (off by default)
- Every key decryption logged to `key_access_log` (customer-visible)
- Worker source is MIT-licensed and public — you can verify what we do with your data
- Subprocessors: Cloudflare, Stripe, Brevo, Anthropic

## License

MIT — see [LICENSE](LICENSE)
