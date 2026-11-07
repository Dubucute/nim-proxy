// src/app.js — Express application factory.
//
// `createApp()` wires config, logging, the key pool, the upstream client, the
// model catalogue, request log, middleware and routes, and returns them so
// tests can grab handles. It touches no globals, so the same app serves both
// `node server.js` and the Vercel handler in api/index.js.

'use strict';

const express = require('express');
const compression = require('compression');

const configModule = require('./config');
const { createLogger } = require('./logger');
const { KeyPool } = require('./keys');
const { Upstream } = require('./upstream');
const { ModelCatalog } = require('./models');
const { RequestLog } = require('./request-log');
const {
  withRequestContext, securityHeaders, corsMiddleware, rateLimit,
  requireJsonBody, createErrorHandler, notFound,
} = require('./middleware');
const { createChatRouter } = require('./routes/chat');
const { createModelsRouter } = require('./routes/models');
const { createPassthroughRouter, ENDPOINTS, isMultipart } = require('./routes/passthrough');
const { createDashboardRouter } = require('./routes/dashboard');
const { createHealthRouter } = require('./routes/health');
const pkg = require('../package.json');

const MULTIPART_PATHS = Object.entries(ENDPOINTS)
  .filter(([, spec]) => spec.acceptsMultipart)
  .map(([path]) => `/v1${path}`);

function createApp(overrides = {}) {
  const config = overrides.config || configModule.load(overrides.env || process.env);
  const logger = overrides.logger || createLogger(config.logLevel, { json: /^(1|true|yes)$/i.test(process.env.LOG_JSON || '') });
  const keyPool = overrides.keyPool || new KeyPool(config.apiKeys, { cooldownMs: config.keyCooldownMs, logger });
  const upstream = overrides.upstream || new Upstream(config, { keyPool, logger });
  const catalog = overrides.catalog || new ModelCatalog({ upstream, config, logger });
  const requestLog = overrides.requestLog || new RequestLog({ maxEntries: config.requestLogSize });

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  if (config.isServerless || /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '')) {
    app.set('trust proxy', true);
  }

  // ── Response plumbing ────────────────────────────────────────────────────
  // Skip compression for event streams: gzip holds back small chunks waiting to
  // fill a block, which turns token streaming into stuttering.
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
      const type = res.getHeader('Content-Type') || '';
      if (String(type).includes('text/event-stream')) return false;
      const custom = res.getHeader('X-Compression');
      if (custom === 'off') return false;
      return compression.filter(req, res);
    },
  }));

  app.use(securityHeaders);
  app.use(withRequestContext);
  app.use(corsMiddleware(config.corsOrigins));

  // ── Body parsing ─────────────────────────────────────────────────────────
  // 100mb was an unbounded-memory invitation for a JSON endpoint that should
  // never see anything near that. Parsers are built once at startup, and
  // multipart uploads on the file endpoints are captured as raw bytes so they
  // can be relayed to NVIDIA with the caller's own boundary header.
  const jsonParser = express.json({ limit: config.bodyLimit, strict: true });
  const rawParser = express.raw({ type: 'multipart/form-data', limit: config.bodyLimit });

  app.use((req, res, next) => {
    if (MULTIPART_PATHS.includes(req.path) && isMultipart(req)) return rawParser(req, res, next);
    return jsonParser(req, res, next);
  });

  app.use((req, res, next) => {
    res.setHeader('X-Proxy-Version', pkg.version);
    next();
  });

  // ── Limits ───────────────────────────────────────────────────────────────
  app.use('/v1', rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    logger,
  }));

  app.use('/v1', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) return requireJsonBody(req, res, next);
    return next();
  });

  // ── Routes ───────────────────────────────────────────────────────────────
  const deps = { config, logger, keyPool, upstream, catalog, requestLog };
  app.use('/', createHealthRouter(deps));
  app.use('/v1', createModelsRouter(deps));
  app.use('/v1', createChatRouter(deps));
  app.use('/v1', createPassthroughRouter(deps));
  app.use('/', createDashboardRouter(deps));

  app.use(notFound);
  app.use(createErrorHandler({ logger, requestLog }));

  app.locals.services = deps;

  return { app, config, logger, keyPool, upstream, catalog, requestLog };
}

module.exports = { createApp };
