// test/helpers/harness.js — Boots the proxy against the stub upstream.

'use strict';

const { startStub } = require('./stub-upstream');
const { createApp } = require('../../src/app');

function hasHeader(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

/**
 * @param {object} [env] extra environment overrides
 * @returns {Promise<{url: string, stub, close: () => Promise<void>, request: Function, json: Function}>}
 */
async function withProxy(env = {}) {
  const stub = await startStub();

  const config = require('../../src/config').load({
    NIM_API_BASE: stub.baseUrl,
    NIM_API_KEY: 'nvapi-testkey-one',
    NIM_API_KEY_2: 'nvapi-testkey-two',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'error',
    RATE_LIMIT_MAX: '0',
    REQUEST_TIMEOUT_MS: '5000',
    STREAM_IDLE_TIMEOUT_MS: '1500',
    MAX_RETRIES: '2',
    BODY_LIMIT: '1mb',
    ...env,
  });

  const silent = { debug() {}, info() {}, warn() {}, error() {}, redact: (v) => v, redactText: (v) => String(v), maskToken: () => '****' };
  const created = createApp({ config, logger: silent });
  const { app } = created;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  const close = async () => {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
    created.upstream.close();
    await stub.close();
  };

  const request = (path, options = {}) => {
    const method = options.method || (options.body === undefined ? 'GET' : 'POST');
    let body;
    const explicitHeaders = { ...(options.headers || {}) };
    if (method !== 'GET' && method !== 'HEAD' && options.body !== undefined) {
      if (typeof options.body === 'string' || Buffer.isBuffer(options.body) || options.body instanceof Uint8Array) {
        body = options.body;
      } else if (options.body instanceof FormData) {
        body = options.body; // let fetch set the multipart boundary itself
      } else {
        body = JSON.stringify(options.body);
      }
    }
    const wantsContentType = body !== undefined && !hasHeader(explicitHeaders, 'content-type');
    return fetch(url + path, {
      ...options,
      method,
      headers: {
        ...(wantsContentType && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        ...explicitHeaders,
      },
      body,
    });
  };

  const json = async (path, options = {}) => {
    const res = await request(path, options);
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* keep raw for assertions */ }
    return { res, status: res.status, headers: Object.fromEntries(res.headers.entries()), text, body: parsed };
  };

  /** Collect a streamed response body as text. */
  const stream = async (path, body) => {
    const res = await request(path, { body, method: 'POST' });
    const text = await res.text();
    const events = text.split('\n\n').filter((frame) => frame.startsWith('data:'));
    return { res, status: res.status, text, events };
  };

  return { url, stub, close, request, json, stream, services: created };
}

/** Parse an SSE transcript into [{event, data, isDone}] using the wire format only. */
function parseSseTranscript(text) {
  const out = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue;
    let event = null;
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    out.push({ event, data, isDone: data === '[DONE]', json: data && data !== '[DONE]' ? safeJson(data) : null });
  }
  return out;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

module.exports = { withProxy, parseSseTranscript };
