// src/logger.js — Levelled console logging with secret redaction.
//
// The proxy sees upstream API keys in transit; a single accidental
// `console.log(headers)` would put one in a log aggregator or a Vercel
// trace. Everything goes through redact() so that cannot happen.

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const NVAPI_RE = /\bnvapi-[A-Za-z0-9_\-]{6,}/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9_\-.\+/=]{8,}/gi;
const KEYED_RE = /("(?:api[_-]?key|apikey|authorization|token|access_token)"\s*:\s*")([^"]+)(")/gi;

function maskToken(token) {
  if (!token || token.length <= 10) return '****';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function redactText(text) {
  return String(text)
    .replace(NVAPI_RE, (m) => maskToken(m))
    .replace(BEARER_RE, (_m, p) => `${p}${maskToken(_m.slice(p.length))}`)
    .replace(KEYED_RE, (_m, p, v, s) => `${p}${maskToken(v)}${s}`);
}

// Deep-redact anything we're about to serialise, without mutating the input.
function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(authorization|x-nim-key|api[-_]?key|apikey|cookie)$/i.test(k)) {
        out[k] = maskToken(typeof v === 'string' ? v : String(v ?? ''));
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function createLogger(level = 'info', { json = false } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(levelName, min, args) {
    if (LEVELS[levelName] < min) return;
    const consoleFn = console[levelName === 'debug' ? 'log' : levelName] || console.log;
    if (json) {
      const [first, ...rest] = args;
      const payload = { ts: new Date().toISOString(), level: levelName, msg: redact(first) };
      if (rest.length) payload.extra = redact(rest);
      consoleFn(JSON.stringify(payload));
      return;
    }
    consoleFn(...args.map((a) => (typeof a === 'string' ? redactText(a) : redact(a))));
  }

  return {
    level: threshold,
    debug: (...args) => emit('debug', threshold, args),
    info: (...args) => emit('info', threshold, args),
    warn: (...args) => emit('warn', threshold, args),
    error: (...args) => emit('error', threshold, args),
    redact,
    redactText,
    maskToken,
  };
}

module.exports = { createLogger, redactText, redact, maskToken, NVAPI_RE };
