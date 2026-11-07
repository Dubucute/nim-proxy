// test/audio.test.js — Inline audio input through the proxy.
//
// The hosted gateway has no /v1/audio/* routes, but omni chat models accept
// OpenAI input_audio content parts inside /v1/chat/completions (verified live:
// nvidia/nemotron-3-nano-omni-30b-a3b-reasoning transcribed a spoken WAV). The
// proxy must relay those parts and the modalities/audio fields untouched.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shared = require('../shared');
const { buildNimRequest } = require('../src/translate');
const { withProxy } = require('./helpers/harness');

const OMNI = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
// A tiny valid WAV header + a few samples; content is irrelevant to the relay.
const WAV_B64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

test('audio-input capability is detected for the omni model, not for text models', () => {
  assert.equal(shared.getAudioInputCapability(OMNI), true);
  assert.equal(shared.getAudioInputCapability('meta/muse-glimmer-30b'), false);
  assert.equal(shared.getAudioInputCapability('microsoft/phi-4'), false);
});

test('buildNimRequest forwards modalities and audio fields', () => {
  const { request } = buildNimRequest({
    model: OMNI,
    messages: [{ role: 'user', content: 'hi' }],
    modalities: ['text', 'audio'],
    audio: { voice: 'alloy', format: 'wav' },
  });
  assert.deepEqual(request.modalities, ['text', 'audio']);
  assert.deepEqual(request.audio, { voice: 'alloy', format: 'wav' });
});

test('input_audio content parts survive translation untouched', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Transcribe this.' },
      { type: 'input_audio', input_audio: { data: WAV_B64, format: 'wav' } },
    ],
  }];
  const { request } = buildNimRequest({ model: OMNI, messages });
  assert.deepEqual(request.messages, messages);
});

test('the proxy relays an input_audio request to upstream intact', async () => {
  const ctx = await withProxy();
  try {
    const body = {
      model: OMNI,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Transcribe this.' },
        { type: 'input_audio', input_audio: { data: WAV_B64, format: 'wav' } },
      ] }],
      max_tokens: 200,
    };
    const { status } = await ctx.json('/v1/chat/completions', { method: 'POST', body });
    assert.equal(status, 200);

    const sent = ctx.stub.lastRequest().body;
    assert.equal(sent.model, OMNI);
    assert.deepEqual(sent.messages[0].content[1], { type: 'input_audio', input_audio: { data: WAV_B64, format: 'wav' } });
  } finally { await ctx.close(); }
});

test('the proxy forwards modalities/audio for audio-output requests', async () => {
  const ctx = await withProxy();
  try {
    const { status } = await ctx.json('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: OMNI,
        messages: [{ role: 'user', content: 'Say hello.' }],
        modalities: ['text', 'audio'],
        audio: { voice: 'alloy', format: 'wav' },
      },
    });
    assert.equal(status, 200);
    const sent = ctx.stub.lastRequest().body;
    assert.deepEqual(sent.modalities, ['text', 'audio']);
    assert.deepEqual(sent.audio, { voice: 'alloy', format: 'wav' });
  } finally { await ctx.close(); }
});

test('/v1/models flags the omni model audioInput and supports the tag filter', async () => {
  const ctx = await withProxy();
  try {
    const all = await ctx.json('/v1/models');
    const omni = all.body.data.find((m) => m.id === OMNI);
    assert.equal(omni.capabilities.audioInput, true);
    assert.equal(omni.capabilities.chat, true);
    const glimmerless = all.body.data.find((m) => m.id === 'microsoft/phi-4');
    assert.equal(glimmerless.capabilities.audioInput, false);

    const tagged = await ctx.json('/v1/models?tag=audioInput');
    assert.deepEqual(tagged.body.data.map((m) => m.id), [OMNI]);
  } finally { await ctx.close(); }
});

test('the missing /v1/audio/transcriptions route points at the inline-audio workaround', async () => {
  const ctx = await withProxy();
  try {
    ctx.stub.setMissingRoutes(['/v1/audio/transcriptions']);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'clip.wav');
    form.append('model', 'nvidia/parakeet-tdt-0.6b-v2');
    const res = await ctx.request('/v1/audio/transcriptions', { method: 'POST', body: form, headers: {} });
    const body = await res.json();
    assert.equal(res.status, 501);
    assert.match(body.error.message, /input_audio content part/);
    assert.match(body.error.message, /nemotron-3-nano-omni/);
  } finally { await ctx.close(); }
});
