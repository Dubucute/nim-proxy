// server.js — Entry point.
//
// Thin by design: configuration, middleware and routes live under src/. The
// Express app is still exported for Vercel's handler in api/index.js, and the
// HTTP listener only starts when this file is run directly.

'use strict';

require('dotenv').config();

const { createApp } = require('./src/app');

const services = createApp();
const { app, config, logger, keyPool, upstream, catalog } = services;

module.exports = app;
module.exports.services = services;

if (require.main === module) {
  if (keyPool.size === 0) {
    logger.warn('[startup] No NIM_API_KEY found in the environment. /v1 requests will fail until one is set.');
    logger.warn('[startup] Generate a free key at https://build.nvidia.com/ and add it to .env (see .env.example).');
  }
  logger.info(`[startup] nim-proxy listening on http://${config.host}:${config.port}`);
  logger.info(`[startup] upstream ${config.nimApiBase} | keys ${keyPool.size} | body limit ${config.bodyLimit} | rate limit ${config.rateLimitMax > 0 ? `${config.rateLimitMax}/${Math.round(config.rateLimitWindowMs / 1000)}s` : 'off'}`);
  logger.info(`[startup] dashboard ${config.dashboardEnabled ? `http://localhost:${config.port}/logs` : 'disabled'}`);

  const server = app.listen(config.port, config.host, () => {
    // Warm the catalogue so the first /v1/models call is not a cold start.
    catalog.ensure().catch((err) => logger.warn(`[startup] model prefetch failed: ${err.message}`));
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[shutdown] ${signal} received — draining connections (max 10s)`);

    const force = setTimeout(() => {
      logger.error('[shutdown] forced exit after 10s');
      process.exit(1);
    }, 10000);
    force.unref();

    server.close((err) => {
      if (err) logger.error(`[shutdown] error while closing: ${err.message}`);
      upstream.close();
      clearTimeout(force);
      logger.info('[shutdown] closed');
      process.exit(err ? 1 : 0);
    });

    // Node 18.2+: stop accepting new keep-alive sockets immediately.
    server.closeIdleConnections?.();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('[unhandledRejection]', reason));
  process.on('uncaughtException', (err) => {
    logger.error('[uncaughtException]', err);
    shutdown('uncaughtException');
  });
}
