// tools/probe-catalogue.js — Find out which catalogue models your key can actually use.
//
// /v1/models lists what NVIDIA publishes, not what the account behind NIM_API_KEY
// may invoke (moonshotai/kimi-k2.6 is listed and returns "Not found for account").
// This tool sends one tiny request per model and records the real outcome:
//
//   ok            answered (also flags reasoning-only answers)
//   retired       410 Gone with an end-of-life date
//   not_entitled  404 "Function ... Not found for account"
//   unknown       404 page not found
//   forbidden     403 (capability or credential — body inspected)
//   rate_limited  429
//   error         anything else
//
// Usage:
//   node tools/probe-catalogue.js                 # all chat-classified models
//   node tools/probe-catalogue.js --all           # every model in the catalogue
//   node tools/probe-catalogue.js --filter nemotron --concurrency 4
//   node tools/probe-catalogue.js --vision        # also probe image support (data URI)
//   node tools/probe-catalogue.js --filter gpt-oss --merge   # retry into existing report
//
// Writes tools/catalogue-probe.json (git-ignored) and prints a summary table.

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const shared = require('../shared');

const BASE = (process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
const KEY = process.env.NIM_API_KEY || process.env.NVIDIA_API_KEY;
const OUT = path.join(__dirname, 'catalogue-probe.json');

// 1x1 red PNG — small enough to keep vision probes cheap.
const TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function parseArgs(argv) {
  const args = { all: false, vision: false, merge: false, concurrency: 3, filter: null, timeoutMs: 60000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--vision') args.vision = true;
    else if (argv[i] === '--merge') args.merge = true;
    else if (argv[i] === '--filter') args.filter = argv[++i];
    else if (argv[i] === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 3);
    else if (argv[i] === '--timeout') args.timeoutMs = Math.max(5000, Number(argv[++i]) || 60000);
  }
  return args;
}

async function call(model, messages, maxTokens, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain-text gateway errors */ }
    return { status: res.status, json, text, ms: Date.now() - startedAt };
  } catch (err) {
    return { status: 0, json: null, text: err.name === 'AbortError' ? 'timeout' : err.message, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function classify(result) {
  const { status, json, text } = result;
  const detail = json?.detail || json?.error?.message || json?.message || text || '';

  if (status === 200) {
    const msg = json?.choices?.[0]?.message || {};
    const finish = json?.choices?.[0]?.finish_reason;
    if (!msg.content && msg.reasoning_content) {
      return { verdict: 'ok', note: `reasoning only (${msg.reasoning_content.length} chars, finish=${finish}) — raise max_tokens` };
    }
    return { verdict: 'ok', note: `answered in ${result.ms}ms`, usage: json?.usage || null };
  }
  if (status === 410) return { verdict: 'retired', note: String(detail).slice(0, 160) };
  if (status === 404) {
    if (/not found for account/i.test(detail)) return { verdict: 'not_entitled', note: 'listed but this account cannot invoke it' };
    return { verdict: 'unknown', note: String(detail).slice(0, 120) };
  }
  if (status === 403) {
    if (/authorization failed|unauthori[sz]ed|invalid jwt/i.test(detail)) return { verdict: 'forbidden_auth', note: 'key rejected' };
    return { verdict: 'forbidden', note: String(detail).slice(0, 120) };
  }
  if (status === 429) return { verdict: 'rate_limited', note: 'retry later' };
  if (status === 0) return { verdict: 'error', note: String(detail).slice(0, 120) };
  return { verdict: 'error', note: `HTTP ${status}: ${String(detail).slice(0, 120)}` };
}

async function probeModel(model, args) {
  // Text probe: generous budget so reasoning models reach an answer.
  const textResult = await call(model.id, [{ role: 'user', content: 'Reply with exactly: ok' }], 400, args.timeoutMs);
  const entry = { id: model.id, type: model.type, ...classify(textResult), latencyMs: textResult.ms };

  if (args.vision && entry.verdict === 'ok') {
    const visionResult = await call(model.id, [{
      role: 'user',
      content: [
        { type: 'text', text: 'What color is this image? One word.' },
        { type: 'image_url', image_url: { url: TEST_IMAGE } },
      ],
    }], 400, args.timeoutMs);
    const v = classify(visionResult);
    // An explicit "not multimodal" / "multimodal not enabled" 400 is a real
    // negative, not an inconclusive probe. Timeouts and 5xx stay inconclusive.
    const unsupported = /not a multimodal model|multimodal processing is not enabled|does not support (?:image|vision|multimodal)/i.test(v.note || '');
    entry.vision = v.verdict === 'ok' ? true : (v.verdict === 'forbidden' || unsupported) ? false : `inconclusive:${v.verdict}`;
    if (typeof entry.vision === 'string') entry.visionNote = v.note;
  }
  return entry;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!KEY) {
    console.error('Set NIM_API_KEY first (free key at https://build.nvidia.com/).');
    process.exit(1);
  }

  const listRes = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${KEY}` } });
  if (!listRes.ok) {
    console.error(`Could not list models: HTTP ${listRes.status}`);
    process.exit(1);
  }
  const catalogue = (await listRes.json()).data || [];

  let targets = catalogue.map((m) => ({ id: m.id, type: shared.getModelType(m.id) }));
  if (!args.all) targets = targets.filter((m) => m.type === 'chat');
  if (args.filter) targets = targets.filter((m) => m.id.toLowerCase().includes(args.filter.toLowerCase()));

  console.log(`Probing ${targets.length} of ${catalogue.length} models (concurrency ${args.concurrency}${args.vision ? ', vision on' : ''})...\n`);

  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const model = targets[cursor++];
      const entry = await probeModel(model, args);
      results.push(entry);
      const mark = entry.verdict === 'ok' ? 'OK ' : entry.verdict.toUpperCase().slice(0, 3);
      console.log(`[${mark}] ${entry.id.padEnd(52)} ${entry.verdict.padEnd(13)} ${entry.note || ''}${entry.vision !== undefined ? `  vision=${entry.vision}` : ''}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(args.concurrency, targets.length) }, worker));

  // --merge folds this run into the existing report by model id (new results win),
  // so a --filter retry doesn't clobber a previous full sweep.
  let merged = results;
  if (args.merge && fs.existsSync(OUT)) {
    try {
      const prior = JSON.parse(fs.readFileSync(OUT, 'utf8')).results || [];
      const byId = new Map(prior.map((r) => [r.id, r]));
      for (const r of results) byId.set(r.id, r);
      merged = [...byId.values()];
    } catch { /* corrupt prior report: fall back to this run only */ }
  }

  merged.sort((a, b) => a.id.localeCompare(b.id));
  const counts = {};
  for (const r of merged) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  const report = {
    probedAt: new Date().toISOString(),
    upstream: BASE,
    totalCatalogue: catalogue.length,
    probed: merged.length,
    counts,
    visionTested: args.vision,
    results: merged,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log(`\nSummary: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`Report: ${OUT}${args.merge ? ' (merged)' : ''}`);

  const usable = merged.filter((r) => r.verdict === 'ok').map((r) => r.id);
  console.log(`\nUsable chat models (${usable.length}):`);
  for (const id of usable) console.log(`  ${id}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
