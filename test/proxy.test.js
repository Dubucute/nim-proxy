// test/proxy.test.js — End-to-end behaviour of the proxy surface.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withProxy, parseSseTranscript } = require('./helpers/harness');
const { MODES } = require('./helpers/stub-upstream');

const CHAT = { model: 'meta/llama-3.1-8b-instruct', messages: [{ role: 'user', content: 'hi' }] };

test('chat completions returns an OpenAI-shaped response', async () => {
  const ctx = await withProxy();
  try {
    const { status, body, headers } = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    assert.equal(status, 200);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices.length, 1);
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.deepEqual(body.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.ok(headers['x-request-id']);
    assert.equal(headers['x-powered-by'], undefined, 'no framework fingerprint');
  } finally { await ctx.close(); }
});

test('tools, response_format and multimodal content pass through untouched', async () => {
  const ctx = await withProxy();
  try {
    await ctx.json('/v1/chat/completions', {
      method: 'POST',
      body: {
        ...CHAT,
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
        tool_choice: 'auto',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'what sun?' }, { type: 'image_url', image_url: { url: 'https://x/y.png' } }] }],
      },
    });
    const sent = ctx.stub.lastRequest().body;
    assert.equal(sent.tools[0].function.name, 'get_weather');
    assert.equal(sent.tool_choice, 'auto');
    assert.equal(sent.response_format.type, 'json_object');
    assert.equal(sent.messages[0].content[1].type, 'image_url');
  } finally { await ctx.close(); }
});

test('tool calls and reasoning survive the response transform', async () => {
  const ctx = await withProxy();
  try {
    // stub returns a plain message; assert the transform keeps extra fields
    const { toChatCompletion } = require('../src/translate');
    const out = toChatCompletion({
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }], reasoning_content: 'thinking' }, finish_reason: 'tool_calls' }],
    }, 'm');
    assert.equal(out.choices[0].message.tool_calls[0].id, 'call_1');
    assert.equal(out.choices[0].message.reasoning_content, 'thinking');
    assert.equal(out.choices[0].message.content, null);
    assert.equal(out.choices[0].finish_reason, 'tool_calls');
  } finally { await ctx.close(); }
});

test('legacy /v1/completions maps prompt -> messages and back', async () => {
  const ctx = await withProxy();
  try {
    const { status, body } = await ctx.json('/v1/completions', { method: 'POST', body: { model: 'writer/nex-n2-predict-33b-instruct', prompt: 'def reverse(s):', max_tokens: 32 } });
    assert.equal(status, 200);
    assert.equal(body.object, 'text_completion');
    assert.equal(body.choices[0].text, 'stub reply');
    const sent = ctx.stub.lastRequest().body;
    assert.equal(sent.messages[0].content, 'def reverse(s):');
    assert.equal(sent.max_tokens, 32);
    assert.equal(sent.temperature, 0.2);
  } finally { await ctx.close(); }
});

test('legacy completions stream too', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(MODES.STREAM_USAGE);
    const { text } = await ctx.stream('/v1/completions', { model: 'x', prompt: 'abc', stream: true });
    assert.ok(text.includes('data: [DONE]'));
  } finally { await ctx.close(); }
});

test('NVIDIA returning no choices becomes a typed 502, not an empty 200', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(MODES.EMPTY_CHOICES);
    const { status, body } = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    assert.equal(status, 502);
    assert.equal(body.error.type, 'upstream_error');
    assert.match(body.error.message, /no choices/);
  } finally { await ctx.close(); }
});

test('a rejected pool key is disabled and reported as a server fault, not the caller\'s', async () => {
  const ctx = await withProxy({ NIM_API_KEY: 'nvapi-keythatisrejected000000', NIM_API_KEY_2: 'nvapi-keythatisusable0000000000' });
  try {
    ctx.stub.setMode(MODES.UNAUTHORIZED);
    const { status, body } = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    // NVIDIA rejecting *our* key must not look like "your key is wrong" to the client.
    assert.equal(status, 502);
    assert.equal(body.error.type, 'upstream_auth_error');
    assert.match(body.error.message, /Verify NIM_API_KEY/);

    const logs = await ctx.json('/api/logs');
    assert.equal(logs.body.keys.disabled, 2, 'both pool keys marked disabled');
    assert.ok(!JSON.stringify(logs.body).includes('keythatisrejected'), 'status does not echo key material');
  } finally { await ctx.close(); }
});

test("a caller's own rejected key is reported to that caller as 401", async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(MODES.UNAUTHORIZED);
    const { status, body } = await ctx.json('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer nvapi-callersownbadkey000000' },
      body: CHAT,
    });
    assert.equal(status, 401);
    assert.match(body.error.message, /key supplied with this request/);
  } finally { await ctx.close(); }
});

test('upstream 5xx is retried and the client is told', async () => {
  const ctx = await withProxy({ MAX_RETRIES: '1' });
  try {
    ctx.stub.setMode(MODES.SERVER_ERROR);
    const { status, headers, body } = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    assert.equal(status, 502, 'upstream 500 surfaces as a gateway error');
    assert.equal(ctx.stub.state.chatCalls, 2, 'one retry happened');
    assert.equal(body.error.type, 'upstream_error');
    assert.ok(headers['x-request-id']);
  } finally { await ctx.close(); }
});

test('client disconnect stops the upstream request', async () => {
  const ctx = await withProxy({ STREAM_IDLE_TIMEOUT_MS: '5000' });
  try {
    ctx.stub.setMode(MODES.STREAM_STALL);
    const ac = new AbortController();
    const pending = ctx.request('/v1/chat/completions', { method: 'POST', body: { ...CHAT, stream: true }, signal: ac.signal })
      .then((r) => r.text());
    await new Promise((r) => setTimeout(r, 120));
    ac.abort();
    await pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const logs = await ctx.json('/api/logs');
    const entry = logs.body.entries[0];
    assert.equal(entry.outcome, 'aborted', `expected abort, got ${JSON.stringify(entry)}`);
    assert.equal(entry.status, 499);
  } finally { await ctx.close(); }
});

test('GET /v1/models lists, filters and annotates', async () => {
  const ctx = await withProxy();
  try {
    const all = await ctx.json('/v1/models');
    assert.equal(all.status, 200);
    assert.equal(all.body.data.length, 3);
    assert.equal(all.body.total, 3, 'total must match data length');
    assert.equal(all.body.data.find((m) => m.id === 'nvidia/nv-embedqa-e5-v5').type, 'embedding');

    const chats = await ctx.json('/v1/models?type=chat');
    assert.deepEqual(chats.body.data.map((m) => m.id), ['meta/llama-3.1-8b-instruct', 'microsoft/phi-4']);
    assert.ok(chats.body.data[0].capabilities.chat);

    const limit = await ctx.json('/v1/models?limit=1');
    assert.equal(limit.body.data.length, 1);
    assert.match(all.headers['cache-control'], /max-age=/);
  } finally { await ctx.close(); }
});

test('GET /v1/models/:id returns one model or a 404', async () => {
  const ctx = await withProxy();
  try {
    const found = await ctx.json(`/v1/models/${encodeURIComponent('microsoft/phi-4')}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.id, 'microsoft/phi-4');
    assert.equal(found.body.object, 'model');

    const missing = await ctx.json('/v1/models/nope%2Fnope');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error.message, /not available/);
  } finally { await ctx.close(); }
});

test('GET /v1/models/ranked puts benchmarked models first', async () => {
  const ctx = await withProxy();
  try {
    const { status, body } = await ctx.json('/v1/models/ranked?limit=3');
    assert.equal(status, 200);
    assert.ok(body.data.length <= 3);
    assert.equal(typeof body.benchmarkedCount, 'number');
    assert.equal(body.query.limit, '3');
  } finally { await ctx.close(); }
});

test('an unknown category filter yields an empty list, not the whole catalogue', async () => {
  const ctx = await withProxy();
  try {
    const { body } = await ctx.json('/v1/models/ranked?category=does-not-exist');
    assert.deepEqual(body.data, []);
  } finally { await ctx.close(); }
});

test('embeddings normalise a bare string input into an array', async () => {
  const ctx = await withProxy();
  try {
    const { status } = await ctx.json('/v1/embeddings', { method: 'POST', body: { model: 'nvidia/nv-embedqa-e5-v5', input: 'hello' } });
    assert.equal(status, 200);
    assert.deepEqual(ctx.stub.lastRequest().body.input, ['hello']);
  } finally { await ctx.close(); }
});

test('multipart uploads are relayed byte-for-byte with the original boundary', async () => {
  const ctx = await withProxy();
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'audio/wav' }), 'clip.wav');
    form.append('model', 'nvidia/parakeet-tdt-0.6b-v2');
    const res = await ctx.request('/v1/audio/transcriptions', { method: 'POST', body: form, headers: {} });
    const text = await res.text();
    assert.equal(res.status, 200, text);

    const sent = ctx.stub.lastRequest();
    assert.match(sent.headers['content-type'], /^multipart\/form-data; boundary=/, 'boundary preserved');
    assert.ok(sent.raw.includes(Buffer.from([5, 6, 7, 8])), 'binary file bytes survived intact');
    assert.match(sent.raw.toString('latin1'), /clip\.wav/);
  } finally { await ctx.close(); }
});

test('a retired model surfaces NVIDIA\'s end-of-life detail as 410, not axios boilerplate', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(MODES.MODEL_RETIRED);
    const { status, body } = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    assert.equal(status, 410);
    assert.equal(body.error.type, 'model_unavailable');
    assert.match(body.error.message, /end of life/);
    assert.match(body.error.message, /Pick a current model from \/v1\/models/);
    assert.doesNotMatch(body.error.message, /^Request failed with status code/);
  } finally { await ctx.close(); }
});

test('a speech endpoint the upstream does not implement reports 501 with guidance, not a bare 404', async () => {
  const ctx = await withProxy();
  try {
    // The hosted gateway really does answer `404 page not found` for /v1/audio/*.
    ctx.stub.setMissingRoutes(['/v1/audio/transcriptions']);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'clip.wav');
    form.append('model', 'nvidia/parakeet-tdt-0.6b-v2');

    const res = await ctx.request('/v1/audio/transcriptions', { method: 'POST', body: form, headers: {} });
    const body = await res.json();

    assert.equal(res.status, 501);
    assert.equal(body.error.type, 'upstream_unsupported_endpoint');
    assert.match(body.error.message, /does not implement \/audio\/transcriptions/);
    assert.match(body.error.message, /self-hosted/, 'tells the caller what to do');
    assert.doesNotMatch(body.error.message, /^404 page not found$/, 'not the raw upstream text');
  } finally { await ctx.close(); }
});

test('a genuine upstream 400 is unwrapped even when it arrives as text/plain JSON', async () => {
  const ctx = await withProxy();
  try {
    // The gateway answers `{"error":{...}}` with content-type text/plain, which
    // used to be forwarded as a JSON blob nested inside the error message.
    ctx.stub.setMode(MODES.BAD_REQUEST_TEXT);
    const { status, body } = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    assert.equal(status, 400);
    assert.equal(body.error.message, 'model field is required');
    assert.doesNotMatch(body.error.message, /^\{/, 'no nested JSON');
  } finally { await ctx.close(); }
});

test('non-JSON content types are rejected with 415 instead of a crash', async () => {  const ctx = await withProxy();
  try {
    const { status, body } = await ctx.json('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello',
    });
    assert.equal(status, 415);
    assert.match(body.error.message, /Content-Type must be application\/json/);
  } finally { await ctx.close(); }
});

test('malformed JSON and oversized bodies get clean 400/413s', async () => {
  const ctx = await withProxy({ BODY_LIMIT: '8kb' });
  try {
    const bad = await ctx.json('/v1/chat/completions', { method: 'POST', body: '{"model": "x",,}' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /not valid JSON/);

    const big = await ctx.json('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'y'.repeat(20000) }] }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(big.status, 413);
    assert.match(big.body.error.message, /exceeds the configured limit/);
  } finally { await ctx.close(); }
});

test('OPTIONS preflight answers without touching upstream', async () => {
  const ctx = await withProxy();
  try {
    const res = await ctx.request('/v1/chat/completions', { method: 'OPTIONS', headers: { Origin: 'https://example.test' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://example.test');
    assert.ok(/POST/.test(res.headers.get('access-control-allow-methods')));
    assert.equal(ctx.stub.state.chatCalls, 0);
  } finally { await ctx.close(); }
});

test('CORS_ORIGIN allow-list restricts browsers but not server-to-server calls', async () => {
  const ctx = await withProxy({ CORS_ORIGIN: 'https://allowed.test' });
  try {
    const allowed = await ctx.request('/v1/models', { headers: { Origin: 'https://allowed.test' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.test');
    const denied = await ctx.request('/v1/models', { headers: { Origin: 'https://evil.test' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const direct = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    assert.equal(direct.status, 200, 'non-browser callers are unaffected');
  } finally { await ctx.close(); }
});

test('per-client rate limiting returns 429 with Retry-After', async () => {
  const ctx = await withProxy({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' });
  try {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT }));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 429, 429]);
    assert.ok(results[3].headers['retry-after'], 'Retry-After advertised');
    assert.equal(results[3].body.error.type, 'rate_limit_error');
    assert.equal(ctx.stub.state.chatCalls, 3, 'throttled requests never reach NVIDIA');
  } finally { await ctx.close(); }
});

test('GET /health reports state without calling upstream', async () => {
  const ctx = await withProxy();
  try {
    const before = ctx.stub.state.modelsCalls;
    const { status, body } = await ctx.json('/health');
    assert.equal(status, 200);
    assert.equal(ctx.stub.state.modelsCalls, before, 'health is not an upstream probe');
    assert.equal(body.status, 'ok');
    assert.equal(body.keys.configured, 2);
    assert.ok(!JSON.stringify(body).includes('nvapi-'), 'health never echoes key material');
    assert.equal(body.limits.rate, 'none', 'limiter disabled in the default test config');
  } finally { await ctx.close(); }
});

test('GET /health?deep=true probes NVIDIA', async () => {
  const ctx = await withProxy();
  try {
    const { body } = await ctx.json('/health?deep=true');
    assert.equal(body.deep.ok, true);
    assert.equal(body.deep.models, 3);
    assert.equal(ctx.stub.state.modelsCalls, 1);
  } finally { await ctx.close(); }
});

test('health is 503 with no keys configured, and chat explains itself', async () => {
  const ctx = await withProxy({ NIM_API_KEY: '', NIM_API_KEY_2: '' });
  try {
    const health = await ctx.json('/health');
    assert.equal(health.status, 503);
    assert.equal(health.body.status, 'degraded');
    assert.ok(health.body.warnings.some((w) => /no NIM_API_KEY/.test(w)));

    const chat = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    assert.equal(chat.status, 503);
    assert.match(chat.body.error.message, /No NVIDIA API key available/);
    assert.equal(ctx.stub.state.chatCalls, 0, 'fails before spending a request');
  } finally { await ctx.close(); }
});

test('dashboard can be switched off', async () => {
  const ctx = await withProxy({ DASHBOARD_ENABLED: 'false' });
  try {
    const { status, body } = await ctx.json('/logs');
    assert.equal(status, 404);
    assert.match(body.error.message, /Dashboard disabled/);
  } finally { await ctx.close(); }
});

test('unknown endpoints return a JSON 404 with the request id', async () => {
  const ctx = await withProxy();
  try {
    const { status, body, headers } = await ctx.json('/v1/whatever');
    assert.equal(status, 404);
    assert.match(body.error.message, /GET \/v1\/whatever not found/);
    assert.equal(body.error.request_id, headers['x-request-id']);
  } finally { await ctx.close(); }
});

test('debug headers expose proxy internals on request, without secrets', async () => {
  const ctx = await withProxy();
  try {
    const { headers, body } = await ctx.json('/v1/chat/completions?debug=true', {
      method: 'POST', body: { ...CHAT, max_tokens: 999999 },
    });
    assert.ok(headers['x-proxy-request-id']);
    assert.equal(headers['x-nim-model'], CHAT.model);
    assert.match(headers['x-proxy-notes'] || '', /clamped/);
    assert.ok(!JSON.stringify(headers).includes('nvapi-'));
    assert.equal(body.usage.total_tokens, 8);
  } finally { await ctx.close(); }
});

test('streaming transcript is valid SSE with one terminator', async () => {
  const ctx = await withProxy();
  try {
    const { text, res } = await ctx.stream('/v1/chat/completions', { ...CHAT, stream: true });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    const events = parseSseTranscript(text);
    assert.ok(events.length >= 1);
    assert.equal(events.filter((e) => e.isDone).length, 1);
    assert.equal(events.at(-1).isDone, true);
    for (const event of events.filter((e) => !e.isDone)) assert.ok(event.json, `frame is JSON: ${event.data}`);
  } finally { await ctx.close(); }
});
