// src/models.js — NVIDIA model catalogue with a shared cache.
//
// Fixes the thundering herd: six simultaneous /v1/models requests used to make
// six upstream calls because the cache was only populated after each await
// finished. Now there is one in-flight promise for everyone, plus
// stale-while-revalidate so an NVIDIA outage serves the last good list instead
// of an empty array.

'use strict';

const shared = require('../shared');

class ModelCatalog {
  constructor({ upstream, config, logger = console }) {
    this.upstream = upstream;
    this.config = config;
    this.log = logger;
    this.models = [];
    this.fetchedAt = 0;
    this.inflight = null;
    this.lastError = null;
  }

  get fresh() {
    return this.models.length > 0 && Date.now() - this.fetchedAt < this.config.modelsCacheTtlMs;
  }

  get ageMs() { return this.fetchedAt ? Date.now() - this.fetchedAt : null; }

  /** Coalesced refresh: concurrent callers share one upstream call. */
  async ensure({ force = false, signal } = {}) {
    if (!force && this.fresh) return this.models;
    if (this.inflight) {
      try { return await this.inflight; }
      catch { return this.models; } // fall back to whatever we already have
    }

    this.inflight = this.#fetch(signal)
      .then((models) => { this.inflight = null; return models; })
      .catch((err) => { this.inflight = null; throw err; });

    try {
      return await this.inflight;
    } catch (err) {
      this.lastError = err.message;
      const withinGrace = this.models.length > 0 &&
        Date.now() - this.fetchedAt < this.config.modelsStaleGraceMs;
      if (withinGrace) {
        this.log.warn(`[models] refresh failed (${err.message}); serving stale list from ${Math.round((Date.now() - this.fetchedAt) / 1000)}s ago`);
        return this.models;
      }
      throw err;
    }
  }

  async #fetch(signal) {
    const response = await this.upstream.request({
      path: '/models',
      method: 'GET',
      signal,
    });
    const list = Array.isArray(response.data?.data) ? response.data.data : [];
    if (list.length === 0) {
      // An empty list is almost certainly an upstream problem, not the truth.
      throw new Error('NVIDIA returned an empty model list');
    }

    const annotated = list.map((model) => {
      const type = shared.getModelType(model.id);
      return {
        id: model.id,
        object: 'model',
        created: model.created || Math.floor(Date.now() / 1000),
        owned_by: model.owned_by || 'nvidia',
        type,
        capabilities: {
          chat: type === 'chat',
          embedding: type === 'embedding',
          image: type === 'image',
          audio: type === 'audio',
          safety: type === 'safety',
          toolCalling: type === 'chat',
          vision: shared.getVisionCapability(model.id),
        },
      };
    });

    this.models = annotated;
    this.fetchedAt = Date.now();
    this.lastError = null;
    this.log.info(`[models] refreshed catalogue (${annotated.length} models)`);
    return annotated;
  }

  /** Attach benchmark fields from benchmark_data.json, if known. */
  annotate(models) {
    const { lookup } = shared.loadBenchmarkData();
    return models.map((model) => {
      const bench = lookup[model.id];
      if (!bench) return model;
      return {
        ...model,
        benchmark: {
          rank: bench.rank,
          combinedScore: bench.combinedScore,
          speed: bench.speed?.responseTimeSec,
          speedRank: bench.speed?.rank,
          codingScore: bench.coding?.score,
          codingPercentage: bench.coding?.percentage,
          tasksPassed: bench.coding?.tasksPassed,
        },
      };
    });
  }

  find(id) {
    return this.models.find((m) => m.id === id) || null;
  }
}

/** Apply the query filters shared by /v1/models and /v1/models/ranked. */
function applyFilters(models, query, benchmarkRaw) {
  let out = models;

  if (query.type) {
    const wanted = String(query.type).toLowerCase();
    out = out.filter((m) => m.type === wanted);
  }

  if (query.tag) {
    const tag = String(query.tag).toLowerCase();
    if (tag === 'vision') out = out.filter((m) => m.capabilities?.vision);
    else if (tag === 'toolcalling' || tag === 'tools') out = out.filter((m) => m.capabilities?.toolCalling);
    else if (['chat', 'embedding', 'image', 'audio', 'safety'].includes(tag)) out = out.filter((m) => m.type === tag);
    else {
      out = out.filter((m) => {
        const bench = m.benchmark;
        if (!bench) return false;
        if ((bench.speedRank || '').toLowerCase().includes(tag)) return true;
        if (tag === 'coding_expert' || tag === 'smart') return (bench.codingPercentage || 0) >= 80;
        if (tag === 'top_tier') return (bench.combinedScore || 0) > 0;
        if (tag === 'best_overall') return (bench.combinedScore || 0) >= 8000;
        return false;
      });
    }
  }

  if (query.minScore !== undefined) {
    const min = Number(query.minScore);
    if (Number.isFinite(min)) out = out.filter((m) => (m.benchmark?.combinedScore || 0) >= min);
  }

  if (query.category) {
    const allowed = benchmarkRaw?.categories?.[query.category];
    if (Array.isArray(allowed) && allowed.length) {
      const set = new Set(allowed);
      out = out.filter((m) => set.has(m.id));
    } else {
      out = []; // asked for a category that does not exist: be explicit, not silent
    }
  }

  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (Number.isInteger(limit) && limit > 0) out = out.slice(0, Math.min(limit, 5000));
  }

  return out;
}

module.exports = { ModelCatalog, applyFilters };
