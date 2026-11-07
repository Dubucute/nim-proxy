// test/vision.test.js — Remote image URLs must become data URIs the gateway accepts.
//
// Background: meta/muse-glimmer-30b is vision-capable, but NVIDIA's hosted
// gateway returns a bare 403 for image_url parts pointing at external https://
// URLs while accepting the same bytes as a data URI. The proxy inlines them.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { urlToDataUri, inlineRemoteImages, hasImageContent, isPrivateHost, sniffMime, ImageFetchError } = require('../src/vision');
const shared = require('../shared');
const { withProxy } = require('./helpers/harness');

// 1x1 red PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function withImageServer(handler) {
  const server = http.createServer((req, res) => handler(req, res, PNG));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

test('urlToDataUri downloads an image and encodes it', async () => {
  const srv = await withImageServer((req, res, png) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(png);
  });
  try {
    const uri = await urlToDataUri(`${srv.base}/red.png`, { denyPrivate: false });
    assert.match(uri, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(uri.split(',')[1], 'base64').toString('base64'), PNG.toString('base64'));
  } finally { await srv.close(); }
});

test('urlToDataUri sniffs mime when the server lies about content-type', async () => {
  const srv = await withImageServer((req, res, png) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(png);
  });
  try {
    const uri = await urlToDataUri(`${srv.base}/blob`, { denyPrivate: false });
    assert.match(uri, /^data:image\/png;base64,/, 'magic bytes win over content-type');
  } finally { await srv.close(); }
});

test('urlToDataUri rejects non-images', async () => {
  const srv = await withImageServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>not an image</body></html>');
  });
  try {
    await assert.rejects(() => urlToDataUri(`${srv.base}/page.html`, { denyPrivate: false }), ImageFetchError);
  } finally { await srv.close(); }
});

test('urlToDataUri enforces the size limit against a lying content-length', async () => {
  const srv = await withImageServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' }); // no content-length
    let sent = 0;
    const timer = setInterval(() => {
      sent += 64 * 1024;
      if (sent > 2 * 1024 * 1024) { clearInterval(timer); res.destroy(); return; }
      res.write(Buffer.alloc(64 * 1024));
    }, 1);
  });
  try {
    await assert.rejects(
      () => urlToDataUri(`${srv.base}/huge.png`, { maxBytes: 256 * 1024, denyPrivate: false }),
      /exceeds the/,
    );
  } finally { await srv.close(); }
});

test('SSRF guard refuses private hosts unless explicitly allowed', async () => {
  await assert.rejects(
    () => urlToDataUri('http://169.254.169.254/latest/meta-data/', {}),
    /private address/,
    'cloud metadata endpoint blocked by default',
  );
  assert.ok(isPrivateHost('127.0.0.1') && isPrivateHost('10.1.2.3') && isPrivateHost('localhost'));
  assert.ok(!isPrivateHost('images.example.com'));
});

test('ALLOWED_IMAGE_HOSTS restricts which hosts may be fetched', async () => {
  const srv = await withImageServer((req, res, png) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  try {
    await assert.rejects(
      () => urlToDataUri(`${srv.base}/red.png`, { allowedHosts: new Set(['cdn.trusted.test']), denyPrivate: false }),
      /not in ALLOWED_IMAGE_HOSTS/,
    );
  } finally { await srv.close(); }
});

test('inlineRemoteImages rewrites only remote image parts', async () => {
  const srv = await withImageServer((req, res, png) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  try {
    const request = {
      model: 'meta/muse-glimmer-30b',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [
          { type: 'text', text: 'what color?' },
          { type: 'image_url', image_url: { url: `${srv.base}/red.png` } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ] },
      ],
    };
    const { request: out, changed, notes } = await inlineRemoteImages(request, { enabled: true, denyPrivate: false });
    assert.ok(changed);
    assert.match(out.messages[1].content[1].image_url.url, /^data:image\/png/);
    assert.equal(out.messages[1].content[2].image_url.url, 'data:image/png;base64,AAAA', 'existing data URIs untouched');
    assert.equal(out.messages[0].content, 'be brief', 'string content untouched');
    assert.ok(notes.some((n) => /inlined/.test(n)));
  } finally { await srv.close(); }
});

test('hasImageContent detects multimodal payloads', () => {
  assert.ok(hasImageContent([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }]));
  assert.ok(!hasImageContent([{ role: 'user', content: 'plain' }]));
});

test('verified vision models are classified even without a name keyword', () => {
  assert.equal(shared.getVisionCapability('meta/muse-glimmer-30b'), true);
  assert.equal(shared.getVisionCapability('deepseek-ai/deepseek-v4.1-flash'), true);
  assert.equal(shared.getVisionCapability('microsoft/phi-4'), false);
  assert.equal(shared.getVisionCapability('nvidia/nemotron-3-ultra-550b-a55b'), false);
});

test('the proxy inlines a remote image before calling upstream', async () => {
  const img = await withImageServer((req, res, png) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  const ctx = await withProxy({ INLINE_REMOTE_IMAGES: 'true', IMAGE_MAX_BYTES: '1048576', ALLOW_PRIVATE_IMAGE_HOSTS: 'true' });
  try {
    const body = {
      model: 'meta/muse-glimmer-30b',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what color is this?' },
        { type: 'image_url', image_url: { url: `${img.base}/red.png` } },
      ] }],
    };
    const { status } = await ctx.json('/v1/chat/completions', { method: 'POST', body });
    assert.equal(status, 200);

    const sent = ctx.stub.lastRequest().body;
    const sentUrl = sent.messages[0].content[1].image_url.url;
    assert.match(sentUrl, /^data:image\/png;base64,/, `upstream got: ${String(sentUrl).slice(0, 60)}`);
    assert.ok(!sentUrl.includes('127.0.0.1'), 'no loopback URL reaches NVIDIA');
  } finally { await img.close(); await ctx.close(); }
});

test('the SSRF default survives the proxy path: loopback refused unless opted in', async () => {
  const img = await withImageServer((req, res, png) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  const ctx = await withProxy({ INLINE_REMOTE_IMAGES: 'true' }); // private hosts still denied
  try {
    const { status, body } = await ctx.json('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'meta/muse-glimmer-30b',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: `${img.base}/red.png` } },
        ] }],
      },
    });
    assert.equal(status, 400);
    assert.match(body.error.message, /private address/);
    assert.equal(ctx.stub.state.chatCalls, 0, 'refused before any upstream call');
  } finally { await img.close(); await ctx.close(); }
});

test('without the flag the URL passes through and the note explains the risk', async () => {
  const ctx = await withProxy(); // INLINE_REMOTE_IMAGES defaults off
  try {
    const { status, headers } = await ctx.json('/v1/chat/completions?debug=true', {
      method: 'POST',
      body: {
        model: 'meta/muse-glimmer-30b',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'https://images.example.test/a.png' } },
        ] }],
      },
    });
    assert.equal(status, 200);
    assert.match(headers['x-proxy-notes'] || '', /INLINE_REMOTE_IMAGES/);
    assert.equal(ctx.stub.lastRequest().body.messages[0].content[1].image_url.url, 'https://images.example.test/a.png');
  } finally { await ctx.close(); }
});

test('a 403 on an image request tells the caller about URL blocking, not model capability', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMode(require('./helpers/stub-upstream').MODES.FORBIDDEN_CAPABILITY);
    const { status, body } = await ctx.json('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'meta/muse-glimmer-30b',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'https://images.example.test/a.png' } },
        ] }],
      },
    });
    assert.equal(status, 403);
    assert.match(body.error.message, /refused to fetch an external image URL/);
    assert.match(body.error.message, /INLINE_REMOTE_IMAGES/);
  } finally { await ctx.close(); }
});
