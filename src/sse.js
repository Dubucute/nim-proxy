// src/sse.js — Server-Sent Events relay for NVIDIA NIM streams.
//
// The previous implementation did `buffer += chunk.toString()` and looked for a
// line *containing* "[DONE]". That produced four distinct failures, all of which
// are covered by tests:
//
//   * chunk.toString() decodes each chunk independently, so a multi-byte UTF-8
//     sequence split across two TCP segments became U+FFFD (broken CJK/emoji).
//   * `line.includes('[DONE]')` matched model output that merely mentions the
//     token, which both leaked the raw frame (skipping the nvext strip) and
//     consumed the "already sent [DONE]" flag, so the real terminator vanished
//     and clients hung waiting for end-of-stream.
//   * An upstream socket reset was reported as a clean completion: the relay
//     happily wrote "[DONE]" onto a half-finished answer.
//   * Anything that failed to parse fell through to a raw write, leaking NVIDIA
//     `nvext` telemetry to the caller.
//
// This relay decodes with a StringDecoder, follows the SSE framing rules, and
// distinguishes done / stalled / upstream-error / client-aborted.

'use strict';

const { StringDecoder } = require('string_decoder');

const DONE_EVENT = '[DONE]';
const MAX_LINE_BYTES = 8 * 1024 * 1024; // guard against an endless non-newline stream

/**
 * Parse one SSE frame (the text between blank lines) into fields.
 * Returns null for comment-only/empty frames.
 */
function parseSseFrame(frame) {
  const out = { data: [], event: null, id: null, retry: null, raw: frame };
  let sawField = false;
  for (const line of frame.split('\n')) {
    const pair = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (pair === '') continue;
    if (pair.startsWith(':')) { sawField = true; continue; } // comment / keep-alive
    const colon = pair.indexOf(':');
    const field = colon === -1 ? pair : pair.slice(0, colon);
    let value = colon === -1 ? '' : pair.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    sawField = true;
    if (field === 'data') out.data.push(value);
    else if (field === 'event') out.event = value;
    else if (field === 'id') out.id = value;
    else if (field === 'retry') out.retry = value;
  }
  return sawField ? out : null;
}

function isTerminator(parsed) {
  // Exact match only: `[DONE]` must be the entire data payload of the frame.
  return parsed.data.length === 1 && parsed.data[0].trim() === DONE_EVENT;
}

function sseFrame({ data, event } = {}) {
  let out = '';
  if (event) out += `event: ${event}\n`;
  for (const line of String(data ?? '').split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

function sseErrorFrame(payload) {
  return sseFrame({ event: 'error', data: JSON.stringify(payload) });
}

/**
 * Relay an upstream NIM byte stream to an HTTP response as clean OpenAI SSE.
 *
 * @param {import('stream').Readable} source  upstream response stream
 * @param {import('http').ServerResponse} res  client response
 * @param {object} [opts]
 * @param {number} [opts.idleTimeoutMs]  fail if no bytes arrive for this long
 * @param {(usage: object) => void} [opts.onUsage]  called with streamed usage
 * @param {(stats: object) => void} [opts.onComplete]
 * @returns {Promise<{outcome: string, events: number, usage: object|null, error?: Error}>}
 */
function relaySseStream(source, res, opts = {}) {
  const {
    idleTimeoutMs = 0,
    onUsage,
    onComplete,
    stripFields = ['nvext'],
    requestTimedOut = false,
    isClientGone = null,
  } = opts;

  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let doneSeen = false;
    let finished = false;
    let events = 0;
    let usage = null;
    let lastByteAt = Date.now();
    let stallTimer = null;

    // Backpressure: if the client is slower than NVIDIA, pause the upstream
    // instead of buffering an ever-growing queue in proxy memory.
    const write = (chunk) => {
      if (finished || res.writableEnded || !res.writable) return;
      if (!res.write(chunk)) {
        try { source.pause(); } catch { /* ignore */ }
      }
    };
    res.on('drain', () => { if (!finished) { try { source.resume(); } catch { /* ignore */ } } });

    const finish = (outcome, error) => {
      if (finished) return;
      finished = true;
      if (stallTimer) clearTimeout(stallTimer);
      const stats = { outcome, events, usage, error };
      if (!res.writableEnded && res.writable) {
        if (error) res.write(sseErrorFrame(errorPayloadFor(outcome, error)));
        if (!doneSeen && !error) {
          // Upstream closed without a terminator but also without an error: still
          // close the stream so the client is not left hanging. Logged as truncated.
          res.write(sseFrame({ data: DONE_EVENT }));
        }
      }
      try { if (!res.writableEnded) res.end(); } catch { /* already closed */ }
      if (typeof onComplete === 'function') onComplete(stats);
      resolve(stats);
    };

    const armStallTimer = () => {
      if (!idleTimeoutMs) return;
      if (stallTimer) clearTimeout(stallTimer);
      const wait = Math.max(0, lastByteAt + idleTimeoutMs - Date.now());
      stallTimer = setTimeout(() => {
        if (finished) return;
        const err = new Error(`Upstream stream idle for ${Math.round(idleTimeoutMs / 1000)}s`);
        err.name = 'StreamStallError';
        try { source.destroy(); } catch { /* ignore */ }
        finish('stalled', err);
      }, wait);
    };

    // Frames end at a blank line; keep the remainder buffered until we see one.
    const drainFrames = () => {
      let idx;
      while ((idx = findFrameBoundary(pending)) !== -1) {
        const frame = pending.slice(0, idx.text);
        pending = pending.slice(idx.next);
        if (!handleFrame(frame)) return;
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES) {
        const err = new Error(`Upstream SSE frame exceeded ${MAX_LINE_BYTES} bytes`);
        try { source.destroy(); } catch { /* ignore */ }
        finish('oversized', err);
        return;
      }
      armStallTimer();
    };

    const handleFrame = (frame) => {
      const parsed = parseSseFrame(frame);
      if (!parsed) return true;

      if (isTerminator(parsed)) {
        if (!doneSeen) {
          doneSeen = true;
          res.write(sseFrame({ data: DONE_EVENT }));
        }
        return true;
      }

      const payload = parsed.data.join('\n');
      if (payload === '') return true;

      let rewritten = null;
      try {
        const json = JSON.parse(payload);
        events += 1;
        if (json.usage && (!json.choices || json.choices.length === 0 || !json.choices[0]?.delta?.content)) {
          usage = json.usage;
          if (typeof onUsage === 'function') onUsage(json.usage);
        }
        for (const field of stripFields) {
          if (json && typeof json === 'object' && json[field] !== undefined) delete json[field];
        }
        rewritten = JSON.stringify(json);
      } catch {
        rewritten = null; // not JSON: forward verbatim rather than corrupting it
      }

      const nonDataFields = ['event', 'id', 'retry']
        .filter((f) => parsed[f] !== null)
        .map((f) => `${f}: ${parsed[f]}\n`)
        .join('');
      res.write(`${nonDataFields}${sseFrame({ data: rewritten ?? payload })}`);
      return !finished;
    };

    source.on('data', (chunk) => {
      if (finished) return;
      lastByteAt = Date.now();
      pending += decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      drainFrames();
    });

    source.on('end', () => {
      if (finished) return;
      pending += decoder.end();
      if (pending.trim() !== '') handleFrame(pending);
      finish(doneSeen ? 'done' : 'truncated');
    });

    source.on('error', (err) => {
      // A client hang-up surfaces here too (axios cancels the upstream), so
      // classify it as an abort rather than blaming NVIDIA for the disconnect.
      if (typeof isClientGone === 'function' && isClientGone()) {
        finish('aborted', null);
        return;
      }
      finish(requestTimedOut ? 'stalled' : 'upstream-error', err);
    });

    // Client hung up: stop paying NVIDIA for tokens nobody is reading.
    res.on('close', () => {
      if (finished) return;
      if (!res.writableEnded) {
        try { source.destroy(); } catch { /* ignore */ }
        finish('aborted', null);
      }
    });

    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // nginx/vercel: do not buffer
      res.flushHeaders?.();
    }
    armStallTimer();
  });
}

// SSE frame boundary is a blank line: "\n\n" or "\r\n\r\n".
function findFrameBoundary(text) {
  const lf = text.indexOf('\n\n');
  const crlf = text.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { text: crlf, next: crlf + 4 };
  return { text: lf, next: lf + 2 };
}

function errorPayloadFor(outcome, err) {
  const map = {
    'upstream-error': { type: 'upstream_error', code: 502, message: `Upstream stream failed: ${err.message}` },
    stalled: { type: 'upstream_timeout', code: 504, message: err.message },
    oversized: { type: 'upstream_error', code: 502, message: err.message },
  };
  const detail = map[outcome] || { type: 'upstream_error', code: 502, message: err.message };
  return { error: detail };
}

module.exports = { relaySseStream, parseSseFrame, isTerminator, sseFrame, sseErrorFrame, DONE_EVENT };
