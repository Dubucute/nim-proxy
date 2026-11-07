// src/routes/models.js — GET /v1/models, /v1/models/:id, /v1/models/ranked.
//
// Differences from the original: concurrent requests share one upstream fetch
// (six simultaneous callers used to make six NVIDIA calls), a failed refresh
// serves the last good list instead of an empty array, `total` now describes
// what is actually in `data`, and /v1/models/:id exists because OpenAI SDKs
// call it.

'use strict';

const express = require('express');
const shared = require('../../shared');
const { applyFilters } = require('../models');
const { ProxyError } = require('../errors');

function cacheHeaders(res, { maxAge = 300, stale = 3600 } = {}) {
  res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${stale}`);
}

function createModelsRouter(deps) {
  const router = express.Router();
  const { catalog, requestLog, logger, config } = deps;

  async function load(query) {
    const models = await catalog.ensure();
    const annotated = catalog.annotate(models);
    const benchData = shared.loadBenchmarkData();
    return { annotated, filtered: applyFilters(annotated, query, benchData.raw) };
  }

  router.get('/models', async (req, res, next) => {
    try {
      const { filtered } = await load(req.query);
      cacheHeaders(res);
      res.json({ object: 'list', total: filtered.length, data: filtered });
    } catch (err) {
      next(new ProxyError(
        `Model catalogue unavailable: ${err.message}`,
        { status: 503, type: 'upstream_unavailable', cause: err },
      ));
    }
  });

  router.get('/models/ranked', async (req, res, next) => {
    try {
      const { annotated, filtered } = await load(req.query);
      const lookup = shared.loadBenchmarkData().lookup || {};
      const ranked = shared.getRankedSort([...filtered], lookup);
      const unranked = annotated.length - Object.keys(lookup).length;

      cacheHeaders(res);
      res.json({
        object: 'list',
        total: ranked.length,
        benchmarkedCount: ranked.filter((m) => m.benchmark).length,
        catalogSize: annotated.length,
        unbenchmarked: Math.max(0, unranked),
        query: {
          limit: req.query.limit ?? null,
          minScore: req.query.minScore ?? null,
          category: req.query.category ?? null,
          tag: req.query.tag ?? null,
          type: req.query.type ?? null,
        },
        data: ranked,
      });
    } catch (err) {
      next(new ProxyError(
        `Model catalogue unavailable: ${err.message}`,
        { status: 503, type: 'upstream_unavailable', cause: err },
      ));
    }
  });

  // OpenAI SDKs call retrieve(model) as well as list().
  router.get('/models/:id', async (req, res, next) => {
    try {
      const { annotated } = await load({});
      const wanted = decodeURIComponent(req.params.id);
      const model = annotated.find((m) => m.id === wanted);
      if (!model) {
        throw new ProxyError(`Model "${wanted}" is not available on this proxy`, { status: 404, type: 'invalid_request_error' });
      }
      cacheHeaders(res, { maxAge: 900 });
      res.json({ ...model, object: 'model', benchmark: catalog.annotate([model])[0].benchmark });
    } catch (err) {
      if (err instanceof ProxyError) return next(err);
      return next(new ProxyError(`Model lookup failed: ${err.message}`, { status: 503, type: 'upstream_unavailable', cause: err }));
    }
  });

  return router;
}

module.exports = { createModelsRouter };
