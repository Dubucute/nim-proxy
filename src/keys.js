// src/keys.js — Rotating upstream API key pool with per-key cooldowns.
//
// Changes vs. the original implementation:
//   * round-robin cursor advances per request, so load is actually spread
//   * cooldown honours the upstream `Retry-After` header when present
//   * exponential backoff with jitter instead of a flat 30s
//   * never returns undefined when the pool is empty (callers get a typed error)
//   * `status()` is safe to expose: keys are masked, counts are not

'use strict';

class NoKeysConfiguredError extends Error {
  constructor() {
    super('No upstream API keys configured. Set NIM_API_KEY (and optionally NIM_API_KEY_2, ...).');
    this.name = 'NoKeysConfiguredError';
    this.code = 'no_keys_configured';
  }
}

function parseRetryAfter(headerValue, now = Date.now()) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5 * 60 * 1000);
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - now, 0), 5 * 60 * 1000);
  return null;
}

class KeyPool {
  constructor(keys = [], { cooldownMs = 30000, maxCooldownMs = 5 * 60 * 1000, logger = console } = {}) {
    this.keys = [...new Set(keys.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()))];
    this.baseCooldownMs = cooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.logger = logger;
    this.cursor = 0;
    this.cooldownUntil = new Map(); // index -> expiry ms
    this.consecutive = new Map();   // index -> consecutive rate limits (for backoff)
    this.stats = new Map();         // index -> { used, rateLimited, errors }
    for (let i = 0; i < this.keys.length; i++) {
      this.stats.set(i, { used: 0, rateLimited: 0, errors: 0 });
    }
  }

  get size() { return this.keys.length; }

  pick() {
    if (this.keys.length === 0) throw new NoKeysConfiguredError();
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length;
      const until = this.cooldownUntil.get(idx) || 0;
      if (until <= now) {
        this.cursor = (idx + 1) % this.keys.length; // advance for the next caller
        const s = this.stats.get(idx); if (s) s.used += 1;
        return { key: this.keys[idx], index: idx };
      }
    }
    // Everything is cooling: hand back the key that frees up soonest so the
    // caller can still attempt the request rather than failing outright.
    let bestIdx = 0;
    let bestUntil = Infinity;
    for (const [idx, until] of this.cooldownUntil) if (until < bestUntil) { bestUntil = until; bestIdx = idx; }
    const s = this.stats.get(bestIdx); if (s) s.used += 1;
    return { key: this.keys[bestIdx], index: bestIdx, coolingUntil: bestUntil };
  }

  markRateLimited(index, retryAfterHeader) {
    if (index < 0) return { cooldownMs: 0 }; // caller-supplied key: not ours to cool down
    const now = Date.now();
    const streak = (this.consecutive.get(index) || 0) + 1;
    this.consecutive.set(index, streak);
    const backoff = Math.min(this.baseCooldownMs * 2 ** (streak - 1), this.maxCooldownMs);
    const jitter = Math.floor(backoff * 0.2 * Math.random());
    const fromHeader = parseRetryAfter(retryAfterHeader, now);
    const cooldownUntil = now + Math.max(backoff + jitter, fromHeader ?? 0);
    this.cooldownUntil.set(index, cooldownUntil);
    const s = this.stats.get(index); if (s) { s.rateLimited += 1; }
    this.logger.warn?.(`[keys] key #${index + 1} rate limited; cooling down ${Math.round((cooldownUntil - now) / 1000)}s`);
    return { cooldownMs: cooldownUntil - now };
  }

  markError(index) {
    const s = this.stats.get(index); if (s) s.errors += 1;
  }

  markSuccess(index) {
    this.consecutive.delete(index);
    this.cooldownUntil.delete(index);
  }

  /** Rejects a key for auth/permission failures — it will never work, stop using it. */
  disable(index, reason) {
    this.cooldownUntil.set(index, Infinity);
    const s = this.stats.get(index); if (s) s.disabled = reason;
    this.logger.warn?.(`[keys] key #${index + 1} disabled: ${reason}`);
  }

  allCooling() {
    if (this.keys.length === 0) return false;
    const now = Date.now();
    return this.keys.every((_, i) => (this.cooldownUntil.get(i) || 0) > now);
  }

  nextAvailability() {
    const now = Date.now();
    const waiting = [...this.cooldownUntil.entries()]
      .map(([, until]) => Math.max(0, until - now))
      .filter((ms) => ms > 0);
    return waiting.length ? Math.min(...waiting) : 0;
  }

  // Safe for /health: never returns key material.
  status() {
    const now = Date.now();
    return {
      configured: this.keys.length,
      cooling: [...this.cooldownUntil.entries()].filter(([, until]) => until > now).length,
      disabled: [...this.cooldownUntil.entries()].filter(([, until]) => until === Infinity).length,
      totalUsed: [...this.stats.values()].reduce((a, s) => a + s.used, 0),
      totalRateLimited: [...this.stats.values()].reduce((a, s) => a + s.rateLimited, 0),
      soonestAvailableInMs: this.nextAvailability(),
    };
  }

  masked() {
    return this.keys.map((k, i) => `#${i + 1} ${k.slice(0, 6)}…${k.slice(-4)}`);
  }
}

module.exports = { KeyPool, NoKeysConfiguredError, parseRetryAfter };
