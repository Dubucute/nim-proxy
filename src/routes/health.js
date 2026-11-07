// src/routes/health.js — GET /health and the root index.
//
// The original health check read benchmark JSON off disk on every call, which
// makes it useless as a liveness probe under load and slow on serverless cold
// starts. Here it is pure state inspection; `?deep=true` optionally probes
// NVIDIA with a short timeout so a deploy pipeline can check real reachability.

'use strict';

const express = require('express');
const shared = require('../../shared');
const pkg = require('../../package.json');

function createHealthRouter(deps) {
  const router = express.Router();
  const { config, keyPool, catalog, requestLog, upstream } = deps;

  router.get('/health', async (req, res) => {
    const bench = shared.getBenchmarkSummary(shared.loadBenchmarkData());
    const body = {
      status: keyPool.size > 0 ? 'ok' : 'degraded',
      service: pkg.description,
      version: pkg.version,
      uptimeSec: Math.round(process.uptime()),
      runtime: config.isServerless ? 'serverless' : 'node',
      endpoints: {
        chat: '/v1/chat/completions',
        completions: '/v1/completions',
        embeddings: '/v1/embeddings',
        images: '/v1/images/generations',
        audio: '/v1/audio/transcriptions',
        models: '/v1/models',
        ranked: '/v1/models/ranked',
      },
      keys: keyPool.status(),
      catalogue: { models: catalog.size, ageMs: catalog.ageMs },
      requests: { buffered: requestLog.stats().buffered, total: requestLog.stats().total },
      limits: {
        body: config.bodyLimit,
        rate: config.rateLimitMax > 0 ? `${config.rateLimitMax}/${Math.round(config.rateLimitWindowMs / 1000)}s` : 'none',
        upstreamTimeoutMs: config.requestTimeoutMs,
      },
      warnings: [
        ...(config.corsOrigins === '*' ? ['CORS_ORIGIN is * — any origin may call this proxy'] : []),
        ...(keyPool.size === 0 ? ['no NIM_API_KEY configured'] : []),
      ],
      benchmarks: bench || { status: 'no_benchmark_data' },
    };

    if (req.query.deep === 'true' || req.query.deep === '1') {
      if (config.corsOrigins === '*' && !config.exposeInternalEndpoints) {
        body.deep = { skipped: 'internal endpoints disabled' };
      } else {
        const probe = await upstream.healthProbe(Number(req.query.timeoutMs) || 5000);
        body.deep = probe;
        if (!probe.ok) body.status = 'degraded';
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(keyPool.size > 0 ? 200 : 503).json(body);
  });

  router.get('/', (req, res) => {
    res.json({
      service: 'nim-proxy',
      message: 'OpenAI-compatible proxy in front of NVIDIA NIM. Point an OpenAI SDK at this URL with baseURL set to the host.',
      version: pkg.version,
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      dashboard: config.dashboardEnabled ? '/logs' : 'disabled',
    });
  });

  return router;
}

module.exports = { createHealthRouter };
