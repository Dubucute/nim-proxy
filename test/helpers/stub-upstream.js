// test/helpers/stub-upstream.js — In-process stand-in for integrate.api.nvidia.com.
//
// Every proxy test runs against this: no network, no API keys, deterministic.
// `setMode()` switches what /v1/chat/completions does so failure paths (429,
// stalled streams, truncated streams) are reachable.

'use strict';

const http = require('http');

const MODES = {
  OK: 'ok',
  RATE_LIMIT: '429',
  SERVER_ERROR: '500',
  EMPTY_CHOICES: 'empty-choices',
  STREAM_MULTIBYTE: 'stream-multibyte',
  STREAM_DONE_TEXT: 'stream-done-in-text',
  STREAM_NVEXT: 'stream-nvext',
  STREAM_TRUNCATED: 'stream-truncated',
  STREAM_STALL: 'stream-stall',
  STREAM_USAGE: 'stream-usage',
  STREAM_REASONING_ONLY: 'stream-reasoning-only',
  UNAUTHORIZED: '401',
  BAD_REQUEST_TEXT: '400-text-plain-json',
  MODEL_RETIRED: '410-problem-json',
};

function sse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const frame of frames) res.write(frame);
  res.end();
}

function startStub({ idleMs = 60000 } = {}) {
  const state = { mode: MODES.OK, requests: [], modelsCalls: 0, chatCalls: 0, delayMs: 0, missingRoutes: [] };

  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let parsed = {};
      try { parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { parsed = { __raw: raw.toString('utf8') }; }
      state.requests.push({
        url: req.url, method: req.method, body: parsed, raw,
        headers: req.headers, contentType: req.headers['content-type'],
      });

      if (req.url === '/v1/models') {
        state.modelsCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'meta/llama-3.1-8b-instruct', created: 1700000000, owned_by: 'nvidia' },
            { id: 'nvidia/nv-embedqa-e5-v5', created: 1700000000, owned_by: 'nvidia' },
            { id: 'microsoft/phi-4', created: 1700000000, owned_by: 'nvidia' },
          ],
        }));
        return;
      }

      if (req.url === '/v1/chat/completions') {
        state.chatCalls += 1;
        const delay = (fn, ms = state.delayMs) => (ms > 0 ? setTimeout(fn, ms) : fn());

        if (state.mode === MODES.RATE_LIMIT) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
          res.end(JSON.stringify({ error: { message: 'Too many requests', type: 'rate_limit_error' } }));
          return;
        }
        if (state.mode === MODES.UNAUTHORIZED) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
          return;
        }
        if (state.mode === MODES.SERVER_ERROR) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'server exploded' } }));
          return;
        }
        if (state.mode === MODES.MODEL_RETIRED) {
          // RFC 7807 shape, as returned when NVIDIA ends a model's life.
          res.writeHead(410, { 'content-type': 'application/problem+json' });
          res.end(JSON.stringify({
            type: 'about:blank', title: 'Gone', status: 410,
            detail: `The model '${parsed.model}' has reached its end of life on 2026-08-26T09:00:00Z and is no longer available.`,
          }));
          return;
        }
        if (state.mode === MODES.BAD_REQUEST_TEXT) {
          // Exactly what the hosted gateway does: JSON body, text/plain type.
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: 'model field is required', type: 'invalid_request_error', code: 'missing_required_field' } }));
          return;
        }
        if (state.mode === MODES.EMPTY_CHOICES) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'gen-empty', usage: {} }));
          return;
        }

        if (state.mode === MODES.STREAM_MULTIBYTE) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const payload = 'data: ' + JSON.stringify({
            id: 'gen-1', object: 'chat.completion.chunk', model: 'x',
            choices: [{ index: 0, delta: { content: '\u{1F680} \u4F60\u597D\uFF01 caf\u00E9 \u2014 mixed scripts' }, finish_reason: null }],
          }) + '\n\n';
          const buf = Buffer.from(payload, 'utf8');
          const rocket = buf.indexOf('\u{1F680}', 'utf8');
          // Cut one byte into the 4-byte rocket emoji: naive chunk.toString() yields U+FFFD here.
          delay(() => {
            res.write(buf.subarray(0, rocket + 1));
            setTimeout(() => {
              res.write(buf.subarray(rocket + 1, buf.length - 20));
              res.write(buf.subarray(buf.length - 20));
              res.write('data: [DONE]\n\n');
              res.end();
            }, 5);
          }, 0);
          return;
        }

        if (state.mode === MODES.STREAM_DONE_TEXT || state.mode === MODES.STREAM_NVEXT) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const first = {
            id: 'gen-2', object: 'chat.completion.chunk', model: 'x',
            choices: [{ index: 0, delta: { content: 'The literal data: [DONE] appears inside this sentence.' }, finish_reason: null }],
          };
          if (state.mode === MODES.STREAM_NVEXT) first.nvext = { token_count: 42, kv_cache_hit_rate: 0.9 };
          res.write('data: ' + JSON.stringify(first) + '\n\n');
          res.write('data: ' + JSON.stringify({
            id: 'gen-2', object: 'chat.completion.chunk', model: 'x',
            choices: [{ index: 0, delta: { content: 'TAIL-MUST-ARRIVE' }, finish_reason: 'stop' }],
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (state.mode === MODES.STREAM_TRUNCATED) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ id: 'gen-3', choices: [{ index: 0, delta: { content: 'half an answer' } }] }) + '\n\n');
          setTimeout(() => res.destroy(), 10); // upstream socket dies, no [DONE]
          return;
        }

        if (state.mode === MODES.STREAM_STALL) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ id: 'gen-stall', choices: [{ index: 0, delta: { content: 'first' } }] }) + '\n\n');
          // then nothing at all — the idle timer must fire
          return;
        }

        if (state.mode === MODES.STREAM_REASONING_ONLY) {
          // Reasoning model that never reaches content: budget exhausted mid-thought.
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const piece of ['Let me think', ' about this', ' carefully']) {
            res.write('data: ' + JSON.stringify({
              id: 'gen-r', object: 'chat.completion.chunk', model: 'x',
              choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }],
            }) + '\n\n');
          }
          res.write('data: ' + JSON.stringify({
            id: 'gen-r', object: 'chat.completion.chunk', model: 'x',
            choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (state.mode === MODES.STREAM_USAGE) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ id: 'gen-u', choices: [{ index: 0, delta: { content: 'hi' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ id: 'gen-u', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'gen-ok', created: 1700000000, model: parsed.model, object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'stub reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }));
        return;
      }

      // Any other path: echo what actually reached us.
      const missingRoute = state.missingRoutes.find((p) => req.url === p);
      if (missingRoute) {
        // Mirrors the hosted gateway: a plain-text Go-style 404, not JSON.
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 page not found\n');
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'stub', url: req.url, echoed: parsed, auth: req.headers.authorization || null }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        state,
        setMode(mode) { state.mode = mode; },
        setDelay(ms) { state.delayMs = ms; },
        /** Make these paths answer `404 page not found`, like the hosted gateway. */
        setMissingRoutes(paths) { state.missingRoutes = paths; },
        lastRequest() { return state.requests[state.requests.length - 1]; },
        requestsTo(url) { return state.requests.filter((r) => r.url === url); },
        reset() { state.requests.length = 0; state.modelsCalls = 0; state.chatCalls = 0; state.mode = MODES.OK; },
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

module.exports = { startStub, MODES };
