// test/units.test.js — Unit coverage for the layers the proxy is built from.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSseFrame, isTerminator, sseFrame, relaySseStream } = require('../src/sse');
const { KeyPool, parseRetryAfter } = require('../src/keys');
const { buildNimRequest, validateChatRequest, toChatCompletion, toLegacyCompletion, legacyToChatBody, resolveCallerKey, stripProxyOnlyFields } = require('../src/translate');
const { load: loadConfig } = require('../src/config');
const { redactText, maskToken } = require('../src/logger');
const { PassThrough } = require('node:stream');

// ── SSE framing ────────────────────────────────────────────────────────────
test('parseSseFrame handles LF, CRLF, comments and multi-line data', () => {
  const lf = parseSseFrame('data: {"a":1}\n');
  assert.deepEqual(lf.data, ['{"a":1}']);

  const crlf = parseSseFrame('data: {"a":2}\r\n\r\n'.slice(0, -2));
  assert.deepEqual(crlf.data, ['{"a":2}'], 'trailing CR stripped');

  const comment = parseSseFrame(': keep-alive\n');
  assert.deepEqual(comment.data, [], 'comment carries no data');

  const multiline = parseSseFrame('data: line1\ndata: line2\n');
  assert.equal(multiline.data.join('\n'), 'line1\nline2');
});

test('isTerminator matches only an exact [DONE] payload', () => {
  assert.ok(isTerminator(parseSseFrame('data: [DONE]\n')));
  assert.ok(!isTerminator(parseSseFrame('data: {"c":"see data: [DONE] inline"}\n')),
    'content mentioning [DONE] is not a terminator');
  assert.ok(!isTerminator(parseSseFrame('data: [DONE]extra\n')));
  assert.ok(!isTerminator(parseSseFrame('data:  [DONE] more\n')), 'trailing text disqualifies');
});

test('sseFrame produces valid SSE', () => {
  assert.equal(sseFrame({ data: '[DONE]' }), 'data: [DONE]\n\n');
  assert.equal(sseFrame({ data: 'a\nb' }), 'data: a\ndata: b\n\n');
  assert.equal(sseFrame({ data: 'x', event: 'error' }), 'event: error\ndata: x\n\n');
});

test('relaySseStream reassembles a frame split across three chunks', async () => {
  const source = new PassThrough();
  const written = [];
  const res = fakeRes(written);

  const payload = JSON.stringify({ choices: [{ index: 0, delta: { content: '\u{1F680}\u4F60' } }] });
  const bytes = Buffer.from(`data: ${payload}\n\n`, 'utf8');
  const done = Buffer.from('data: [DONE]\n\n', 'utf8');

  const relay = relaySseStream(source, res, { idleTimeoutMs: 1000 });
  // Split in the middle of the 4-byte rocket emoji and again mid-JSON.
  source.write(bytes.subarray(0, bytes.indexOf(0xF0) + 2));
  source.write(bytes.subarray(bytes.indexOf(0xF0) + 2, bytes.length - 5));
  source.write(bytes.subarray(bytes.length - 5));
  source.write(done);
  source.end();

  const stats = await relay;
  assert.equal(stats.outcome, 'done');
  const text = written.join('');
  assert.ok(!text.includes('\uFFFD'), `no mojibake: ${JSON.stringify(text)}`);
  assert.ok(text.includes('🚀你'), 'multi-byte content intact');
  assert.equal(text.match(/data: \[DONE\]/g).length, 1, 'exactly one terminator');
});

test('relaySseStream flags truncation instead of pretending the answer finished', async () => {
  const source = new PassThrough();
  const written = [];
  const relay = relaySseStream(source, fakeRes(written), {});
  source.write('data: {"choices":[{"delta":{"content":"half"}}]}\n\n');
  source.emit('error', new Error('socket hang up'));
  const stats = await relay;
  assert.equal(stats.outcome, 'upstream-error');
  const text = written.join('');
  assert.match(text, /event: error/, 'client receives an SSE error event');
  assert.ok(!text.includes('data: [DONE]'), 'no fake terminator on failure');
});

test('relaySseStream strips nvext and keeps other fields', async () => {
  const source = new PassThrough();
  const written = [];
  const relay = relaySseStream(source, fakeRes(written), {});
  source.write('data: {"id":"g1","nvext":{"token_count":5},"choices":[{"delta":{"content":"x"}}]}\n\n');
  source.write('data: [DONE]\n\n');
  source.end();
  await relay;
  const text = written.join('');
  assert.ok(!text.includes('nvext'));
  assert.ok(text.includes('"id":"g1"'));
});

test('relaySseStream stops on client disconnect', async () => {
  const source = new PassThrough();
  const written = [];
  const res = fakeRes(written);
  const relay = relaySseStream(source, res, {});
  source.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
  res.emit('close');
  const stats = await relay;
  assert.equal(stats.outcome, 'aborted');
  assert.equal(source.readable, false, 'upstream stream destroyed so we stop paying for tokens');
});

function fakeRes(sink) {
  const { EventEmitter } = require('node:events');
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.writable = true;
  res.setHeader = (k, v) => { res[k] = v; };
  res.flushHeaders = () => {};
  res.write = (chunk) => { sink.push(String(chunk)); return true; };
  res.end = () => { res.writableEnded = true; };
  return res;
}

// ── Key pool ───────────────────────────────────────────────────────────────
test('KeyPool round-robins and skips cooling keys', () => {
  const pool = new KeyPool(['a', 'b', 'c'], { cooldownMs: 1000, logger: { warn() {} } });
  assert.equal(pool.pick().key, 'a');
  assert.equal(pool.pick().key, 'b');
  assert.equal(pool.pick().key, 'c');
  assert.equal(pool.pick().key, 'a');

  pool.markRateLimited(1, '30');
  assert.deepEqual(pool.pick().key, 'c', 'skips the cooling key');
  assert.equal(pool.status().cooling, 1);
  assert.ok(pool.status().soonestAvailableInMs > 0);
  assert.equal(pool.allCooling(), false);
});

test('KeyPool honours Retry-After and grows the cooldown with repeat offences', () => {
  const pool = new KeyPool(['a'], { cooldownMs: 100, logger: { warn() {} } });
  const first = pool.markRateLimited(0);
  const second = pool.markRateLimited(0);
  assert.ok(second.cooldownMs > first.cooldownMs, 'exponential backoff');
  assert.ok(parseRetryAfter('30') === 30000);
  assert.ok(pool.markRateLimited(0, '2').cooldownMs >= 2000, 'header respected');
});

test('KeyPool disables keys that NVIDIA rejects and never blocks forever', () => {
  const pool = new KeyPool(['a', 'b'], { logger: { warn() {} } });
  pool.disable(0, 'rejected');
  assert.equal(pool.status().disabled, 1);
  assert.equal(pool.pick().key, 'b');
  assert.throws(() => new KeyPool([]).pick(), /No upstream API keys configured/);
});

test('KeyPool.status and masked never disclose key material', () => {
  const pool = new KeyPool(['nvapi-SUPERSECRETVALUE0000000000', 'nvapi-ANOTHERSECRETVALUE000000000']);
  assert.ok(!JSON.stringify(pool.status()).includes('SUPERSECRET'));
  assert.ok(!pool.masked().join().includes('SUPERSECRET'));
  assert.match(pool.masked()[0], /^#1 nvapi-…\w{4}$/);
});

// ── Translation ────────────────────────────────────────────────────────────
test('buildNimRequest forwards NIM parameters and drops proxy-only ones', () => {
  const { request, notes } = buildNimRequest({
    model: 'deepseek-ai/deepseek-r1', messages: [{ role: 'user', content: 'x' }],
    apiKey: 'nvapi-SECRET', baseUrl: 'https://evil.example', top_k: 5, min_p: 0.2,
    repetition_penalty: 1.2, n: 1, seed: 3, stop: 'END', presence_penalty: 0.5,
    tools: [{ type: 'function' }], response_format: { type: 'json_object' },
  });
  assert.equal(request.apiKey, undefined);
  assert.equal(request.baseUrl, undefined);
  assert.equal(request.top_k, 5);
  assert.equal(request.min_p, 0.2);
  assert.equal(request.repetition_penalty, 1.2);
  assert.equal(request.seed, 3);
  assert.deepEqual(request.stop, ['END'], 'string stop normalised to array');
  assert.equal(request.max_tokens, 16384, 'deepseek default');
  assert.ok(notes.includes('dropped:apiKey'));
});

test('buildNimRequest prefers max_completion_tokens and clamps to the model ceiling', () => {
  const { request, notes } = buildNimRequest({ model: 'microsoft/phi-4', messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 999999 });
  assert.equal(request.max_tokens, 16384);
  assert.equal(request.max_completion_tokens, undefined);
  assert.ok(notes.some((n) => /clamped/.test(n)), notes.join(';'));

  const exact = buildNimRequest({ model: 'microsoft/phi-4', messages: [{ role: 'user', content: 'x' }], max_tokens: 512 });
  assert.equal(exact.request.max_tokens, 512);
});

test('validateChatRequest rejects the shapes that used to reach NVIDIA', () => {
  assert.throws(() => validateChatRequest({ model: 'm', messages: [] }), /messages is required/);
  assert.throws(() => validateChatRequest({ messages: [] }), /model is required/);
  assert.throws(() => validateChatRequest({ model: 42, messages: [{ role: 'user', content: 'x' }] }), /model is required/);
  assert.throws(() => validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 42 }] }), /content must be a string/);
  assert.throws(() => validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 0 }), /integer >= 1/);
  assert.throws(() => validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: -5 }), /integer >= 1/);
  assert.throws(() => validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], temperature: 9 }), /between 0 and 2/);
  assert.throws(() => validateChatRequest({ model: 'm', messages: [{ role: null, content: 'x' }] }), /role is required/);
  validateChatRequest({ model: 'm', messages: [{ role: 'assistant', content: null, tool_calls: [] }] });
  validateChatRequest({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], stream: true });
});

test('toChatCompletion produces a spec-shaped object with numeric usage', () => {
  const out = toChatCompletion({
    id: 'gen-1', created: 1700000000, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi', tool_calls: [{ id: 't1' }] }, finish_reason: 'tool_calls' }],
    nvext: { token_count: 3 },
  }, 'm');
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].message.tool_calls[0].id, 't1');
  assert.deepEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.equal(out.nvext, undefined);
});

test('legacy completions round-trip', () => {
  const chat = legacyToChatBody({ model: 'm', prompt: 'hello', max_tokens: 64 });
  assert.equal(chat.messages[0].content, 'hello');
  assert.equal(chat.max_tokens, 64);
  assert.equal(chat.temperature, 0.2);

  const legacy = toLegacyCompletion({ choices: [{ index: 0, message: { role: 'assistant', content: 'world' }, finish_reason: 'stop' }], usage: { total_tokens: 4 } }, 'm');
  assert.equal(legacy.object, 'text_completion');
  assert.equal(legacy.choices[0].text, 'world');
});

test('resolveCallerKey understands the real-world key fields', () => {
  const config = { allowBodyApiKey: true };
  assert.equal(resolveCallerKey({ headers: {} }, config).source, 'pool');
  assert.equal(resolveCallerKey({ headers: {}, body: { apiKey: 'proxy-no-auth-needed' } }, config).reason, 'sentinel',
    'the value refresh_config.py writes must not be treated as a key');
  assert.equal(resolveCallerKey({ headers: {}, body: { apiKey: 'none' } }, config).reason, 'sentinel');
  assert.equal(resolveCallerKey({ headers: {}, body: { apiKey: 'short' } }, config).reason, 'malformed');
  assert.equal(resolveCallerKey({ headers: { authorization: 'Bearer nvapi-REALLYLONGKEYVALUE0000' } }, config).source, 'header');
  assert.equal(resolveCallerKey({ headers: {}, body: { apiKey: 'nvapi-REALLYLONGKEYVALUE0000' } }, config).source, 'body');
  assert.equal(resolveCallerKey({ headers: {}, body: { apiKey: 'nvapi-REALLYLONGKEYVALUE0000' } }, { allowBodyApiKey: false }).source, 'pool');
});

test('stripProxyOnlyFields leaves the payload NVIDIA expects', () => {
  const out = stripProxyOnlyFields({ model: 'm', input: ['a'], apiKey: 'x', api_key: 'y', baseUrl: 'z' });
  assert.deepEqual(out, { model: 'm', input: ['a'] });
});

// ── Config ─────────────────────────────────────────────────────────────────
test('config collects, dedupes and validates keys without ever printing them', () => {
  const cfg = loadConfig({ NIM_API_KEY: 'a', NIM_API_KEY_2: 'b', NIM_API_KEY_3: 'b', NVIDIA_API_KEY: 'c', LOG_LEVEL: 'debug' });
  assert.deepEqual(cfg.apiKeys, ['a', 'b', 'c']);
  assert.equal(cfg.logLevel, 'debug');
  assert.equal(cfg.rateLimitMax, 120);
  assert.equal(cfg.rateLimitMax, loadConfig({}).rateLimitMax);
  assert.equal(loadConfig({ RATE_LIMIT_MAX: '0' }).rateLimitMax, 0, '0 disables the limiter');
  assert.deepEqual(loadConfig({ CORS_ORIGIN: 'https://a.test, https://b.test ' }).corsOrigins, ['https://a.test', 'https://b.test']);
});

test('config rejects a non-http NIM_API_BASE instead of trusting it', () => {
  assert.throws(() => loadConfig({ NIM_API_BASE: 'file:///etc/passwd' }), /NIM_API_BASE must be http\(s\)/);
  assert.throws(() => loadConfig({ NIM_API_BASE: 'not a url' }), /Invalid NIM_API_BASE/);
  assert.throws(() => loadConfig({ REQUEST_TIMEOUT_MS: 'soon' }), /must be a number/);
  assert.throws(() => loadConfig({ PORT: '99999' }), /must be <= 65535/);
  assert.throws(() => loadConfig({ DASHBOARD_ENABLED: 'maybe' }), /boolean-ish/);
});

test('config detects serverless runtimes', () => {
  assert.equal(loadConfig({ VERCEL: '1' }).isServerless, true);
  assert.equal(loadConfig({}).isServerless, false);
});

// ── Logger ─────────────────────────────────────────────────────────────────
test('logger redacts key material from arbitrary strings and objects', () => {
  assert.match(redactText('using nvapi-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), /^\*\*\*\*|\S+…\w{4}/);
  assert.ok(!redactText('nvapi-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  assert.ok(!redactText('Authorization: Bearer nvapi-ABCDEFGHIJKLMNOPQRSTUVWXYZ').includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  const obj = redactText(JSON.stringify({ headers: { authorization: 'Bearer nvapi-ABCDEFGHIJKLMNOPQRSTUVWXYZ' } }));
  assert.ok(!obj.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  assert.equal(maskToken('nvapi-1234567890'), 'nvapi-…7890');
});
