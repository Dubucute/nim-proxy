// src/upstream.js — The only place that talks to NVIDIA NIM.
//
// Responsibilities: connection reuse, timeouts that actually apply to streams,
// key rotation with cooldowns, and bounded retries with jitter. The original
// relied on `axios.defaults.httpsAgent` (a global mutation), a flat 120s timeout
// that does not abort a stalled stream, and a hand-copied retry block that threw
// a ReferenceError when it was reached.

'use strict';

const https = require('https');
const http = require('http');
const axios = require('axios');
const { KeyPool } = require('./keys');
const { ProxyError, fromUpstream, isRetryable, isRateLimitError } = require('./errors');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new ProxyError('Request aborted', { status: 499, type: 'aborted' }));
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  function onAbort() { clearTimeout(timer); reject(new ProxyError('Request aborted', { status: 499, type: 'aborted' })); }
  signal?.addEventListener('abort', onAbort, { once: true });
});

function buildAgents() {
  const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: Number(process.env.UPSTREAM_MAX_SOCKETS || 64),
    maxFreeSockets: Number(process.env.UPSTREAM_MAX_FREE_SOCKETS || 16),
    timeout: 30000,
    keepAliveMsecs: 15000,
  });
  const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: Number(process.env.UPSTREAM_MAX_SOCKETS || 64),
    maxFreeSockets: Number(process.env.UPSTREAM_MAX_FREE_SOCKETS || 16),
  });
  return { httpsAgent, httpAgent };
}

function closeAgents({ httpsAgent, httpAgent }) {
  for (const agent of [httpsAgent, httpAgent]) {
    if (!agent) continue;
    for (const key of Object.keys(agent.sockets || {})) {
      for (const socket of agent.sockets[key] || []) socket.destroy();
    }
    agent.destroy?.();
  }
}

function discardBody(data) {
  // A non-2xx response fetched with responseType:'stream' leaves the socket
  // parked with unread data; drain it so keep-alive pools do not leak.
  if (data && typeof data.pipe === 'function' && typeof data.resume === 'function') {
    data.resume();
    data.on('error', () => {});
  }
}

class Upstream {
  constructor(config, { keyPool, logger } = {}) {
    this.config = config;
    this.log = logger || console;
    this.keyPool = keyPool || new KeyPool(config.apiKeys, { cooldownMs: config.keyCooldownMs, logger: this.log });
    this.agents = buildAgents();
    this.client = axios.create({
      baseURL: config.nimApiBase,
      timeout: config.requestTimeoutMs,
      httpsAgent: this.agents.httpsAgent,
      httpAgent: this.agents.httpAgent,
      // Body size is bounded by the proxy's own input limit; upstream responses
      // (images, embeddings) can legitimately be large.
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (status) => status >= 200 && status < 300,
      proxy: false, // never inherit HTTP(S)_PROXY into the signing hop
    });
  }

  /**
   * @param {object} opts
   * @param {string} opts.path        e.g. "/chat/completions" (relative to NIM_API_BASE)
   * @param {object} [opts.body]
   * @param {'stream'|'json'} [opts.responseType]
   * @param {AbortSignal} [opts.signal]
   * @param {object} [opts.headers]
   * @param {boolean} [opts.allowKeyFromPool=true]
   */
  async request(opts) {
    const {
      path, body, responseType = 'json', signal, headers = {}, method = 'POST',
      streamIdleTimeoutMs = 0, onStreamStart,
    } = opts;

    if (!path.startsWith('/')) throw new ProxyError(`upstream path must start with "/" (got ${path})`, { status: 500 });

    const maxAttempts = Math.max(1, (this.config.maxRetries ?? 2) + 1);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw new ProxyError('Request aborted by client', { status: 499, type: 'aborted' });

      let picked;
      try {
        // A caller-supplied key bypasses the pool entirely (index -1 keeps the
        // pool's cooldown bookkeeping honest about keys we do not own).
        picked = opts.apiKey
          ? { key: opts.apiKey, index: -1 }
          : this.keyPool.pick();
      } catch (err) {
        // No keys configured: surface it as a 503 the caller can act on.
        throw new ProxyError(err.message, { status: 503, type: 'server_misconfigured', cause: err });
      }

      const startedAt = Date.now();
      try {
        const response = await this.client.request({
          method,
          url: path,
          data: body,
          responseType,
          signal,
          headers: {
            Authorization: `Bearer ${picked.key}`,
            ...(responseType === 'stream' ? { Accept: 'text/event-stream' } : { Accept: 'application/json' }),
            'Content-Type': 'application/json',
            'X-Request-Attempt': String(attempt),
            ...headers,
          },
        });

        if (picked.index >= 0) this.keyPool.markSuccess(picked.index);
        response.__proxyMeta = {
          keyIndex: picked.index, attempt, startedAt, latencyMs: Date.now() - startedAt,
        };
        if (responseType === 'stream' && typeof onStreamStart === 'function') onStreamStart(response);
        return response;
      } catch (err) {
        lastError = err;
        discardBody(err?.response?.data);

        const status = err?.response?.status;
        const retryAfter = err?.response?.headers?.['retry-after'];

        if ((status === 401 || status === 403) && picked.index >= 0) {
          this.keyPool.disable(picked.index, `rejected (HTTP ${status})`);
          if (this.keyPool.size - this.keyPool.status().disabled <= 0) throw fromUpstream(err);
          continue;
        }
        if ((status === 401 || status === 403) && picked.index < 0) {
          // Caller's own key: their problem, report it faithfully.
          throw new ProxyError('The API key supplied with this request was rejected by NVIDIA.', { status: 401, type: 'invalid_request_error', cause: err });
        }

        if (isRateLimitError(err)) {
          this.keyPool.markRateLimited(picked.index, retryAfter);
        } else if (status >= 500) {
          this.keyPool.markError(picked.index);
        }

        if (!isRetryable(err)) throw fromUpstream(err);

        if (attempt >= maxAttempts) break;

        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        const jitter = Math.floor(Math.random() * 250);
        const wait = backoff + jitter;
        this.log.warn(`[upstream] ${path} attempt ${attempt}/${maxAttempts} failed (${status || err.code || err.message}); retrying in ${wait}ms`);
        await sleep(wait, signal);
      }
    }

    throw fromUpstream(lastError);
  }

  stream(opts) { return this.request({ ...opts, responseType: 'stream' }); }
  json(opts) { return this.request({ ...opts, responseType: 'json' }); }

  async healthProbe(timeoutMs = 5000) {
    // Cheapest authenticated call available: model list, tiny page.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.request({ path: '/models', method: 'GET', signal: controller.signal, body: undefined });
      return { ok: true, models: Array.isArray(res.data?.data) ? res.data.data.length : 0, latencyMs: res.__proxyMeta?.latencyMs };
    } catch (err) {
      return { ok: false, error: err.message, status: err.status };
    } finally {
      clearTimeout(timer);
    }
  }

  close() { closeAgents(this.agents); }
}

module.exports = { Upstream, buildAgents, closeAgents, sleep, discardBody };
