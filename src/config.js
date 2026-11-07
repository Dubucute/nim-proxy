// src/config.js — Environment parsing and validation (single source of truth).
//
// Everything tunable lives here so the rest of the code never touches
// process.env directly. Invalid values fail loudly at startup rather than
// producing surprising runtime behaviour.

'use strict';

const DEFAULTS = {
  NIM_API_BASE: 'https://integrate.api.nvidia.com/v1',
  PORT: 3000,
  HOST: '0.0.0.0',
  LOG_LEVEL: 'info',
  BODY_LIMIT: '10mb',
  REQUEST_TIMEOUT_MS: 120000,
  STREAM_IDLE_TIMEOUT_MS: 120000,
  CONNECT_TIMEOUT_MS: 15000,
  MAX_RETRIES: 2,
  KEY_COOLDOWN_MS: 30000,
  MODELS_CACHE_TTL_MS: 900000,
  MODELS_STALE_GRACE_MS: 86400000,
  RATE_LIMIT_WINDOW_MS: 60000,
  RATE_LIMIT_MAX: 120,
  REQUEST_LOG_SIZE: 500,
  CORS_ORIGIN: '*',
  ALLOW_BODY_API_KEY: true,
  DASHBOARD_ENABLED: true,
};

function num(env, name, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  if (min !== undefined && value < min) throw new Error(`${name} must be >= ${min}, got ${value}`);
  if (max !== undefined && value > max) throw new Error(`${name} must be <= ${max}, got ${value}`);
  return value;
}

function bool(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be a boolean-ish value, got ${JSON.stringify(raw)}`);
}

// NIM_API_KEY, NIM_API_KEY_2 ... NVIDIA_API_KEY — collected and de-duplicated.
function collectKeys(env) {
  const keys = [];
  for (const [name, value] of Object.entries(env)) {
    if (/^(NIM|NVIDIA)_API_KEY(_\d+)?$/.test(name) && typeof value === 'string' && value.trim()) {
      keys.push(value.trim());
    }
  }
  return [...new Set(keys)];
}

function parseOrigins(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '*') return '*';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function load(env = process.env) {
  const port = num(env, 'PORT', 1, 65535) ?? DEFAULTS.PORT;
  const timeout = num(env, 'REQUEST_TIMEOUT_MS', 1000) ?? DEFAULTS.REQUEST_TIMEOUT_MS;
  const logLevel = (env.LOG_LEVEL || DEFAULTS.LOG_LEVEL).toLowerCase();

  const config = {
    isServerless: Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME),

    nimApiBase: (env.NIM_API_BASE || DEFAULTS.NIM_API_BASE).replace(/\/+$/, ''),
    apiKeys: collectKeys(env),

    port,
    host: env.HOST || DEFAULTS.HOST,

    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : DEFAULTS.LOG_LEVEL,
    bodyLimit: env.BODY_LIMIT || DEFAULTS.BODY_LIMIT,
    requestTimeoutMs: timeout,
    streamIdleTimeoutMs: num(env, 'STREAM_IDLE_TIMEOUT_MS', 100) ?? DEFAULTS.STREAM_IDLE_TIMEOUT_MS,
    connectTimeoutMs: num(env, 'CONNECT_TIMEOUT_MS', 1000) ?? DEFAULTS.CONNECT_TIMEOUT_MS,
    maxRetries: num(env, 'MAX_RETRIES', 0, 10) ?? DEFAULTS.MAX_RETRIES,
    keyCooldownMs: num(env, 'KEY_COOLDOWN_MS', 0) ?? DEFAULTS.KEY_COOLDOWN_MS,

    modelsCacheTtlMs: num(env, 'MODELS_CACHE_TTL_MS', 1000) ?? DEFAULTS.MODELS_CACHE_TTL_MS,
    modelsStaleGraceMs: num(env, 'MODELS_STALE_GRACE_MS', 1000) ?? DEFAULTS.MODELS_STALE_GRACE_MS,

    rateLimitWindowMs: num(env, 'RATE_LIMIT_WINDOW_MS', 1000) ?? DEFAULTS.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: num(env, 'RATE_LIMIT_MAX', 0) ?? DEFAULTS.RATE_LIMIT_MAX, // 0 disables

    requestLogSize: num(env, 'REQUEST_LOG_SIZE', 10, 10000) ?? DEFAULTS.REQUEST_LOG_SIZE,

    // NVIDIA's hosted gateway refuses to fetch external image URLs (403), so the
    // proxy downloads them and inlines them as data URIs. Off by default until a
    // caller opts in, because it makes the proxy an HTTP client for caller-chosen
    // URLs — see ALLOWED_IMAGE_HOSTS before enabling on a public deployment.
    inlineRemoteImages: bool(env, 'INLINE_REMOTE_IMAGES') ?? false,
    imageMaxBytes: num(env, 'IMAGE_MAX_BYTES', 1024, 64 * 1024 * 1024) ?? 8 * 1024 * 1024,
    imageTimeoutMs: num(env, 'IMAGE_TIMEOUT_MS', 500) ?? 15000,
    // Private/loopback image hosts are refused by default (SSRF + cloud metadata
    // endpoints). Set true only when images legitimately live on your LAN.
    allowPrivateImageHosts: bool(env, 'ALLOW_PRIVATE_IMAGE_HOSTS') ?? false,
    allowedImageHosts: (() => {
      const raw = env.ALLOWED_IMAGE_HOSTS;
      if (!raw || !raw.trim()) return null;
      return new Set(raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
    })(),

    corsOrigins: parseOrigins(env.CORS_ORIGIN ?? DEFAULTS.CORS_ORIGIN),
    allowBodyApiKey: bool(env, 'ALLOW_BODY_API_KEY') ?? DEFAULTS.ALLOW_BODY_API_KEY,
    dashboardEnabled: bool(env, 'DASHBOARD_ENABLED') ?? DEFAULTS.DASHBOARD_ENABLED,
    exposeInternalEndpoints: bool(env, 'EXPOSE_INTERNAL_ENDPOINTS') ?? true,
  };

  try {
    // Reject anything that is not a plain http(s) origin+path: this value goes
    // straight into the upstream URL, so it must never be attacker-influenced.
    const parsed = new URL(config.nimApiBase);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`NIM_API_BASE must be http(s), got ${parsed.protocol}`);
    }
  } catch (err) {
    throw new Error(`Invalid NIM_API_BASE "${config.nimApiBase}": ${err.message}`);
  }

  return config;
}

module.exports = { load, DEFAULTS };
