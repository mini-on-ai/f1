/**
 * crypto.js — AES-GCM encryption/decryption for customer Anthropic API keys.
 *
 * Design:
 *  - Master secret (F1_KEY_ENCRYPTION_MASTER env var) is a base64-encoded 32-byte key.
 *  - Per-account salt (random 16 bytes, stored in DB) is used with HKDF to derive
 *    a unique account-specific wrapping key. This means compromising one account's
 *    data does NOT expose other accounts' keys.
 *  - IV (random 12 bytes per encryption) is stored alongside the ciphertext in DB.
 *  - Ciphertext is stored as raw bytes (BLOB) in D1.
 *
 * All crypto uses the Web Crypto API (standard in Cloudflare Workers).
 */

// ---------------------------------------------------------------------------
// Internal: derive a per-account AES-GCM key via HKDF
// ---------------------------------------------------------------------------

async function deriveAccountKey(masterKeyBytes, saltBytes) {
  // Import master secret as raw HKDF key material
  const masterKey = await crypto.subtle.importKey(
    "raw",
    masterKeyBytes,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  // Derive a 256-bit AES-GCM key for this account
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: saltBytes,
      info: new TextEncoder().encode("f1-anthropic-key-wrap-v1"),
    },
    masterKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ---------------------------------------------------------------------------
// Parse master secret from env
// ---------------------------------------------------------------------------

function parseMasterSecret(envVar) {
  if (!envVar) throw new Error("F1_KEY_ENCRYPTION_MASTER is not set");
  const bytes = base64ToBytes(envVar.trim());
  if (bytes.length < 32) throw new Error("F1_KEY_ENCRYPTION_MASTER must be at least 32 bytes");
  return bytes;
}

// ---------------------------------------------------------------------------
// Encrypt a customer Anthropic key
// ---------------------------------------------------------------------------

/**
 * Encrypt the customer's Anthropic API key.
 *
 * @param {string} anthropicKey  — plaintext key, e.g. "sk-ant-..."
 * @param {string} masterSecret  — env.F1_KEY_ENCRYPTION_MASTER (base64)
 * @returns {{ ciphertext: Uint8Array, iv: Uint8Array, salt: Uint8Array }}
 *   All three must be stored in the accounts table.
 */
export async function encryptApiKey(anthropicKey, masterSecret) {
  const masterKeyBytes = parseMasterSecret(masterSecret);

  // Generate fresh salt and IV for this encryption
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const accountKey = await deriveAccountKey(masterKeyBytes, salt);

  const plaintext = new TextEncoder().encode(anthropicKey);
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    accountKey,
    plaintext
  );

  return {
    ciphertext: new Uint8Array(ciphertextBuf),
    iv,
    salt,
  };
}

// ---------------------------------------------------------------------------
// Decrypt a customer Anthropic key
// ---------------------------------------------------------------------------

/**
 * Decrypt the customer's Anthropic API key.
 *
 * @param {Uint8Array|ArrayBuffer} ciphertext  — from DB
 * @param {Uint8Array|ArrayBuffer} iv          — from DB
 * @param {Uint8Array|ArrayBuffer} salt        — from DB
 * @param {string} masterSecret               — env.F1_KEY_ENCRYPTION_MASTER (base64)
 * @returns {string} plaintext Anthropic key
 */
export async function decryptApiKey(ciphertext, iv, salt, masterSecret) {
  const masterKeyBytes = parseMasterSecret(masterSecret);
  const accountKey = await deriveAccountKey(
    masterKeyBytes,
    new Uint8Array(salt)
  );

  const plaintextBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    accountKey,
    new Uint8Array(ciphertext)
  );

  return new TextDecoder().decode(plaintextBuf);
}

// ---------------------------------------------------------------------------
// Token hashing (constant-time safe SHA-256 for key comparison)
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext F1 API key or dashboard token for storage.
 * Returns a hex string.
 */
export async function hashToken(token) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return bytesToHex(new Uint8Array(buf));
}

/**
 * SHA-256 of first 2k characters of an input string.
 * Used to detect repeated prompts without storing prompt content.
 */
export async function hashInputPrefix(input) {
  const prefix = typeof input === "string" ? input.slice(0, 2048) : "";
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(prefix)
  );
  return bytesToHex(new Uint8Array(buf));
}

/**
 * Constant-time string comparison to prevent timing attacks on token comparison.
 */
export async function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  const aHash = await hashToken(a);
  const bHash = await hashToken(b);
  // Compare hashes (same length, timing-safe at byte level via subtle.timingSafeEqual
  // — not available in Workers, so compare character-by-character with accumulator)
  let diff = 0;
  for (let i = 0; i < aHash.length; i++) {
    diff |= aHash.charCodeAt(i) ^ bHash.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// IP hashing for audit log (privacy-preserving: daily salt)
// ---------------------------------------------------------------------------

/**
 * Hash a client IP with a daily salt so the audit log can detect anomalies
 * (same IP hammering) without storing raw IPs.
 */
export async function hashIp(ip) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${today}:${ip}`)
  );
  // Return first 16 hex chars — enough to detect repetition, not enough to reverse
  return bytesToHex(new Uint8Array(buf)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random token with the given prefix.
 * Returns plaintext — hash before storing.
 */
export function generateToken(prefix = "f1_key_") {
  const random = crypto.getRandomValues(new Uint8Array(32));
  return prefix + bytesToHex(random);
}

// ---------------------------------------------------------------------------
// Byte utilities
// ---------------------------------------------------------------------------

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
