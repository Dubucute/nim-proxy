// src/request-log.js — Bounded in-memory request log and derived metrics.
//
// Also removes two hazards in the old dashboard: the per-model tally used a
// plain object literal keyed by a *client-supplied* model name, so
// `{"model":"__proto__"}` wrote onto Object.prototype; and error strings were
// rendered straight into HTML. Entries are length-capped here and escaped again
// at the view layer.

'use strict';

const MAX_FIELD = 300;

const cap = (value, size = MAX_FIELD) => {
  if (value === null || value === undefined) return null;
  const str = String(value);
  return str.length > size ? `${str.slice(0, size)}…` : str;
};

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

class RequestLog {
  constructor({ maxEntries = 500 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = [];
    this.counters = { total: 0, errors: 0, rateLimited: 0, streams: 0, tokens: 0 };
  }

  add(entry) {
    const record = {
      reqId: cap(entry.reqId, 64),
      timestamp: entry.timestamp || new Date().toISOString(),
      timeLocal: entry.timeLocal || new Date().toLocaleString(),
      method: cap(entry.method, 8),
      path: cap(entry.path, 200),
      model: cap(entry.model, MAX_FIELD) || 'unknown',
      status: Number.isInteger(entry.status) ? entry.status : 500,
      duration: Number.isFinite(entry.duration) ? entry.duration : 0,
      durationFmt: cap(entry.durationFmt, 16) || '0ms',
      stream: Boolean(entry.stream),
      endpoint: cap(entry.endpoint, 40) || 'chat',
      keyIndex: Number.isInteger(entry.keyIndex) ? entry.keyIndex : null,
      retries: Number.isInteger(entry.retries) ? clampRetries(entry.retries) : 0,
      promptTokens: Number.isInteger(entry.promptTokens) ? entry.promptTokens : 0,
      completionTokens: Number.isInteger(entry.completionTokens) ? entry.completionTokens : 0,
      totalTokens: Number.isInteger(entry.totalTokens) ? entry.totalTokens : 0,
      clientIp: cap(entry.clientIp, 64),
      userAgent: cap(entry.userAgent, 120),
      outcome: cap(entry.outcome, 32),
      error: cap(entry.error, MAX_FIELD),
    };

    this.entries.push(record);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);

    this.counters.total += 1;
    if (record.status >= 400) this.counters.errors += 1;
    if (record.status === 429) this.counters.rateLimited += 1;
    if (record.stream) this.counters.streams += 1;
    this.counters.tokens += record.totalTokens;

    return record;
  }

  recent(limit = 100) {
    const n = Math.max(1, Math.min(Number(limit) || 100, this.maxEntries));
    return this.entries.slice(-n).reverse();
  }

  byModel(limit = 10) {
    // Map, not object literal: model names are attacker controlled.
    const counts = new Map();
    for (const entry of this.entries) counts.set(entry.model, (counts.get(entry.model) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  stats() {
    const durations = this.entries.map((e) => e.duration).sort((a, b) => a - b);
    const byStatus = {};
    for (const entry of this.entries) {
      const bucket = `${Math.floor(entry.status / 100)}xx`;
      byStatus[bucket] = (byStatus[bucket] || 0) + 1;
    }
    return {
      buffered: this.entries.length,
      ...this.counters,
      errorRate: this.counters.total ? +(this.counters.errors / this.counters.total).toFixed(4) : 0,
      avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      byStatus,
    };
  }

  reset() {
    this.entries = [];
    this.counters = { total: 0, errors: 0, rateLimited: 0, streams: 0, tokens: 0 };
  }
}

function clampRetries(value) { return Math.max(0, Math.min(1000, value)); }

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '0ms';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 1000).toFixed(0)}s`;
}

module.exports = { RequestLog, fmtDuration, percentile, MAX_FIELD };
