// src/middleware.js — Request hygiene: ids, headers, CORS, limits, rate limiting.
//
// Replaces `app.use(cors())` + `express.json({limit:'100mb'})` with bounded,
// configurable equivalents, and adds the response headers the old build lacked
// (request id on every response, no stack traces, X-Content-Type-Options, and a
// Content-Security-Policy on the dashboard so a crafted model name cannot
// execute).

'use strict';

const { randomUUID } = require('crypto');
const { ProxyError, errorBody } = require('./errors');
const { fmtDuration } = require('./request-log');

function requestId() {
  return randomUUID().slice(0, 8);
}

function withRequestContext(req, res, next) {
  const inbound = req.headers['x-request-id'];
  req.id = typeof inbound === 'string' && /^[\w.-]{1,64}$/.test(inbound) ? inbound : requestId();
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.id);
  next();
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

/**
 * CORS with an explicit allow-list.
 * `*` (the default) keeps today's behaviour; a list in CORS_ORIGIN locks it down
 * without needing a server restart, and a matched origin gets `Vary: Origin`
 * so shared caches do not leak one site's permission to another.
 */
function corsMiddleware(origins) {
  const allowAll = origins === '*';
  const list = Array.isArray(origins) ? origins : [];

  return (req, res, next) => {
    const origin = req.headers.origin;
    let allowed = allowAll;
    if (!allowAll && origin) allowed = list.includes(String(origin).toLowerCase());

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', allowAll && !origin ? '*' : (origin || '*'));
      if (!allowAll) res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id, Accept');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    return next();
  };
}

/**
 * Fixed-window limiter keyed on the caller's first non-proxy IP.
 * This is not a security boundary on a serverless host (each lambda gets its own
 * counters), but it stops one runaway loop on a long-lived Node process.
 */
function rateLimit({ windowMs = 60000, max = 120, logger = console } = {}) {
  if (!max || max <= 0) return (req, res, next) => next();
  const buckets = new Map();
  let lastSweep = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      lastSweep = now;
    }

    const ip = clientIp(req);
    let bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count += 1;

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
      logger.warn?.(`[ratelimit] ${ip} exceeded ${max} req/${windowMs / 1000}s`);
      return res.status(429).json({
        error: {
          message: `Too many requests from this client (${max} per ${Math.round(windowMs / 1000)}s). Retry in ${Math.max(1, retryAfter)}s.`,
          type: 'rate_limit_error',
          param: null,
          code: '429',
          request_id: req.id,
        },
      });
    }
    return next();
  };
}

// Only trust X-Forwarded-For entries when the request arrived from a proxy we
// know about; otherwise a client can forge its own bucket key.
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const trustProxy = req.app?.get('trust proxy');
  if (forwarded && trustProxy) {
    const first = String(forwarded).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Validate Content-Type / body shape before handlers assume a JSON object.
 * multipart bodies are allowed through untouched for the file endpoints.
 */
function requireJsonBody(req, res, next) {
  const type = String(req.headers['content-type'] || '');
  if (type.includes('multipart/form-data')) return next();
  if (!req.is('application/json') && !req.is('application/*+json')) {
    return next(new ProxyError(
      `Content-Type must be application/json (got "${type || 'unset'}")`,
      { status: 415, type: 'invalid_request_error' },
    ));
  }
  return next();
}

/**
 * Single Express error handler: OpenAI-shaped JSON, never a stack trace.
 * The old build had none, so an unexpected throw produced Express's HTML
 * error page — which is how a ReferenceError leaked `nimRequest is not defined`
 * plus a full file path to the caller.
 */
function createErrorHandler({ logger, requestLog }) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);

    let error = err;
    if (err?.type === 'entity.too.large') {
      error = new ProxyError(`Request body exceeds the configured limit (${process.env.BODY_LIMIT || '10mb'})`, { status: 413, type: 'invalid_request_error', cause: err });
    } else if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      error = new ProxyError('Request body is not valid JSON', { status: 400, type: 'invalid_request_error', cause: err });
    } else if (!(err instanceof ProxyError)) {
      error = new ProxyError(err?.message || 'Internal server error', {
        status: Number.isInteger(err?.status) ? err.status : 500,
        type: err?.type || 'server_error',
        cause: err,
      });
    }

    const duration = Date.now() - (req.startedAt || Date.now());
    logger.error(`[${req.id}] ! ${error.status} ${error.type}: ${error.message}`);
    if (error.status >= 500) logger.debug(err?.stack || err);

    if (requestLog && req.method !== 'OPTIONS') {
      requestLog.add({
        reqId: req.id,
        method: req.method,
        path: req.path,
        model: req.body?.model,
        status: error.status,
        duration,
        durationFmt: fmtDuration(duration),
        error: error.message,
        clientIp: clientIp(req),
        userAgent: req.headers['user-agent'],
      });
    }

    res.status(error.status).json(errorBody(error, req.id));
  };
}

function notFound(req, res, next) {
  next(new ProxyError(`Endpoint ${req.method} ${req.path} not found`, { status: 404, type: 'invalid_request_error' }));
}

module.exports = {
  withRequestContext,
  securityHeaders,
  corsMiddleware,
  rateLimit,
  requireJsonBody,
  createErrorHandler,
  notFound,
  clientIp,
  requestId,
};
