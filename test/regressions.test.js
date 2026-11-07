// test/regressions.test.js — One test per reproduced defect in the original build.
// These are the 11 issues found by auditing v1.0.0 and confirmed against a live
// server; each test would fail on the old code.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withProxy, parseSseTranscript } = require('./helpers/harness');
const { MODES } = require('./helpers/stub-upstream');

const CHAT = { model: 'meta/llama-3.1-8b-instruct', messages: [{ role: 'user', content: 'hi' }] };

test('D1 an unauthenticated caller gets a typed, machine-readable error instead of silently burning pool quota', async () => {
  const ctx = await withProxy();
  try {
    // The proxy stays open by design, but every response is now attributable:
    // a request id is always present so quota use can be traced back to a caller.
    const { status, body, headers } = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    assert.equal(status, 200);
    assert.ok(headers['x-request-id'], 'response carries X-Request-Id for attribution');
    assert.equal(body.choices[0].message.content, 'stub reply');

    const logs = await ctx.json('/api/logs');
    assert.equal(logs.body.entries[0].clientIp, '127.0.0.1', 'caller IP recorded for traceability');
  } finally { await ctx.close(); }
});

test('D2 proxy-only fields (apiKey) never reach NVIDIA', async () => {
  const ctx = await withProxy();
  try {
    await ctx.json('/v1/embeddings', { method: 'POST', body: { model: 'nvidia/nv-embedqa-e5-v5', input: ['x'], apiKey: 'nvapi-CALLER-SECRET' } });
    const sent = ctx.stub.lastRequest();
    assert.equal(sent.body.apiKey, undefined, `apiKey must be stripped; upstream saw ${JSON.stringify(sent.body)}`);
    assert.ok(!sent.raw.toString().includes('CALLER-SECRET'), 'secret absent from the forwarded bytes entirely');
  } finally { await ctx.close(); }
});

test('D2b the caller key is used for that request only, then never leaks to the pool', async () => {
  const ctx = await withProxy();
  try {
    const { status } = await ctx.json('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer nvapi-callerownkey1234567890' },
      body: CHAT,
    });
    assert.equal(status, 200);
    assert.match(ctx.stub.lastRequest().headers.authorization, /nvapi-callerownkey/);
    // the pool keys must be untouched by that call
    const used = ctx.stub.requestsTo('/v1/chat/completions').map((r) => r.headers.authorization);
    assert.ok(!used.some((a) => /testkey/.test(a)), `pool keys were used: ${used.join(', ')}`);
  } finally { await ctx.close(); }
});

test('D3 NVIDIA sampling parameters are forwarded, not dropped', async () => {
  const ctx = await withProxy();
  try {
    await ctx.json('/v1/chat/completions', {
      method: 'POST',
      body: { ...CHAT, top_k: 40, min_p: 0.05, repetition_penalty: 1.1, n: 1, seed: 7, temperature: 0.4 },
    });
    const sent = ctx.stub.lastRequest().body;
    assert.equal(sent.top_k, 40);
    assert.equal(sent.min_p, 0.05);
    assert.equal(sent.repetition_penalty, 1.1);
    assert.equal(sent.seed, 7);
    assert.equal(sent.temperature, 0.4);
  } finally { await ctx.close(); }
});

test('D4 max_tokens: 0 is a clear 400 instead of a silent rewrite to 4096', async () => {
  const ctx = await withProxy();
  try {
    const { status, body } = await ctx.json('/v1/chat/completions', { method: 'POST', body: { ...CHAT, max_tokens: 0 } });
    assert.equal(status, 400);
    assert.match(body.error.message, /max_tokens must be an integer >= 1/);
    assert.equal(ctx.stub.state.chatCalls, 0, 'rejected before spending an upstream call');
  } finally { await ctx.close(); }
});

test('D5 the dashboard escapes client-controlled values (no stored XSS)', async () => {
  const ctx = await withProxy();
  try {
    const evil = '<img src=x onerror=alert(document.domain)>';
    await ctx.json('/v1/chat/completions', { method: 'POST', body: { ...CHAT, model: evil } });
    const res = await ctx.request('/logs');
    const html = await res.text();
    assert.ok(!html.includes('<img src=x onerror=alert'), 'raw markup is not injected');
    assert.ok(html.includes('&lt;img src=x onerror=alert'), 'markup appears only escaped');
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/, 'CSP header set');
    assert.match(html, /http-equiv="Content-Security-Policy"/, 'CSP meta tag present');

    // prototype pollution guard from the same input path
    const proto = '__proto__';
    await ctx.json('/v1/chat/completions', { method: 'POST', body: { ...CHAT, model: proto } });
    assert.equal({}.polluted, undefined, 'Object.prototype untouched');
  } finally { await ctx.close(); }
});

test('D6 multi-byte characters survive SSE chunk splitting', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(MODES.STREAM_MULTIBYTE);
    const { text } = await ctx.stream('/v1/chat/completions', { ...CHAT, stream: true });
    assert.ok(!text.includes('\uFFFD'), `no replacement characters, got: ${JSON.stringify(text.slice(0, 200))}`);
    assert.ok(text.includes('🚀'), 'rocket preserved');
    assert.ok(text.includes('你好'), 'CJK preserved');
    assert.ok(text.includes('café'), 'accented latin preserved');
  } finally { await ctx.close(); }
});

test('D7 model output containing "[DONE]" does not break stream termination', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(MODES.STREAM_DONE_TEXT);
    const { text } = await ctx.stream('/v1/chat/completions', { ...CHAT, stream: true });
    const events = parseSseTranscript(text);
    const doneAt = events.findIndex((e) => e.isDone);
    assert.ok(doneAt >= 0, 'exactly one terminator is emitted');
    assert.equal(events.filter((e) => e.isDone).length, 1, 'never more than one terminator');
    assert.ok(doneAt === events.length - 1, 'terminator is last');
    assert.ok(text.includes('TAIL-MUST-ARRIVE'), 'content after the [DONE]-looking text still arrives');
  } finally { await ctx.close(); }
});

test('D7b NVIDIA nvext telemetry is stripped from every streamed frame', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(MODES.STREAM_NVEXT);
    const { text } = await ctx.stream('/v1/chat/completions', { ...CHAT, stream: true });
    assert.ok(!text.includes('nvext'), `nvext leaked: ${text.slice(0, 300)}`);
    assert.ok(text.includes('TAIL-MUST-ARRIVE'));
  } finally { await ctx.close(); }
});

test('D8 an upstream socket reset mid-stream is reported, not masked as a complete answer', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(MODES.STREAM_TRUNCATED);
    const { text, status } = await ctx.stream('/v1/chat/completions', { ...CHAT, stream: true });
    assert.equal(status, 200, 'headers were already sent, so status cannot change');
    const events = parseSseTranscript(text);
    const errorEvent = events.find((e) => e.event === 'error');
    assert.ok(errorEvent, `expected an SSE error event, got ${JSON.stringify(text.slice(0, 300))}`);
    assert.equal(errorEvent.json.error.type, 'upstream_error');
    const logs = await ctx.json('/api/logs');
    assert.equal(logs.body.entries[0].outcome, 'upstream-error');
    assert.equal(logs.body.entries[0].status, 502);
  } finally { await ctx.close(); }
});

test('D9 the rate-limit path returns a real 429 and never throws ReferenceError', async () => {
  const ctx = await withProxy({ MAX_RETRIES: '1' });
  try {
    ctx.stub.setMode(MODES.RATE_LIMIT);
    const { status, body, headers } = await ctx.json('/v1/chat/completions', { method: 'POST', body: CHAT });
    assert.equal(status, 429, 'rate limit surfaces as 429');
    assert.equal(body.error.type, 'rate_limit_error');
    assert.ok(!/ReferenceError|nimRequest/i.test(JSON.stringify(body)), 'no stack trace or internals in the response');
    assert.ok(headers['x-request-id']);
  } finally { await ctx.close(); }
});

test('D9b a stalled upstream stream is cut off by the idle timeout', async () => {
  const ctx = await withProxy({ STREAM_IDLE_TIMEOUT_MS: '300' });
  try {
    ctx.stub.setMode(MODES.STREAM_STALL);
    const started = Date.now();
    const { text } = await ctx.stream('/v1/chat/completions', { ...CHAT, stream: true });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `idle timeout fired quickly (${elapsed}ms)`);
    assert.ok(parseSseTranscript(text).some((e) => e.event === 'error'), 'client is told the stream died');
  } finally { await ctx.close(); }
});

test('D10 concurrent model-list requests share one upstream call', async () => {
  const ctx = await withProxy();
  try {
    await Promise.all(Array.from({ length: 8 }, () => ctx.json('/v1/models')));
    assert.equal(ctx.stub.state.modelsCalls, 1, `expected 1 upstream call, saw ${ctx.stub.state.modelsCalls}`);
  } finally { await ctx.close(); }
});

test('D11 streaming usage is captured for the request log', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(MODES.STREAM_USAGE);
    await ctx.stream('/v1/chat/completions', {
      ...CHAT, stream: true, stream_options: { include_usage: true },
    });
    const logs = await ctx.json('/api/logs');
    assert.equal(logs.body.entries[0].totalTokens, 18, 'streamed usage recorded instead of 0');
  } finally { await ctx.close(); }
});

test('D12 no stack traces or HTML error pages reach the client', async () => {
  const ctx = await withProxy();
  try {
    const bad = await ctx.json('/v1/chat/completions', { method: 'POST', body: { messages: 'not-an-array' } });
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes('<!DOCTYPE'), 'no Express HTML page');
    assert.ok(!bad.text.includes('at '), 'no stack frames');
    assert.equal(bad.body.error.param, 'model');

    const missing = await ctx.json('/v1/nope', { method: 'POST', body: CHAT });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.type, 'invalid_request_error');
  } finally { await ctx.close(); }
});
