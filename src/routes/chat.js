// src/routes/chat.js — POST /v1/chat/completions and POST /v1/completions.
//
// Structure changed from the original: one pipeline (`runCompletion`) serves
// both endpoints, upstream calls and retries live in src/upstream.js, and every
// failure path ends at the shared error handler. The original had a hand-copied
// retry block inside its catch that referenced `nimRequest` — a const declared
// inside the try — so the second consecutive rate limit threw a ReferenceError
// and answered with an Express HTML stack page instead of a 429.

'use strict';

const express = require('express');
const {
  validateChatRequest, buildNimRequest, toChatCompletion, toLegacyCompletion,
  legacyToChatBody, resolveCallerKey, RequestValidationError,
} = require('../translate');
const { relaySseStream } = require('../sse');
const { ProxyError, errorBody } = require('../errors');
const { clientIp } = require('../middleware');
const { fmtDuration } = require('../request-log');
const { inlineRemoteImages, ImageFetchError, hasImageContent } = require('../vision');

function debugHeadersEnabled(query) {
  return query.debug === 'true' || query.debug === '1';
}

/** Tie an AbortController to the client's connection so we stop paying for tokens nobody reads. */
function linkClientAbort(req, res) {
  const controller = new AbortController();
  let settled = false;
  const abort = (reason) => {
    if (settled) return;
    settled = true;
    controller.reason = reason;
    try { controller.abort(new Error(reason)); } catch { /* ignore */ }
  };
  res.on('close', () => { if (!res.writableEnded && !settled) abort('client_disconnected'); });
  req.on('aborted', () => abort('request_aborted'));
  return {
    signal: controller.signal,
    get abortedBecause() { return controller.reason || null; },
    settle() { settled = true; },
  };
}

function record(requestLog, entry) {
  const duration = entry.duration ?? (Date.now() - entry.startedAt);
  requestLog.add({ ...entry, duration, durationFmt: fmtDuration(duration) });
  return duration;
}

async function runCompletion(req, res, deps, { body, shape }) {
  const { config, logger, upstream, keyPool, requestLog } = deps;
  const startedAt = Date.now();
  const model = body.model;
  const wantsStream = Boolean(body.stream);

  const callerKey = resolveCallerKey(req, config);
  if (!callerKey.key && keyPool.size === 0) {
    throw new ProxyError(
      'No NVIDIA API key available. Set NIM_API_KEY on the server, or send your own key in the Authorization header / apiKey field.',
      { status: 503, type: 'server_misconfigured' },
    );
  }

  const { request: built, notes: buildNotes } = buildNimRequest(body);

  // NVIDIA's gateway will not fetch external image URLs (it answers a bare
  // `403 Forbidden`), so vision requests carrying https:// image parts must be
  // inlined as data URIs before they go upstream. Opt-in via INLINE_REMOTE_IMAGES.
  let nimRequest = built;
  const notes = [...buildNotes];
  if (config.inlineRemoteImages && hasImageContent(built.messages)) {
    try {
      const inlined = await inlineRemoteImages(built, {
        enabled: true,
        maxBytes: config.imageMaxBytes,
        timeoutMs: config.imageTimeoutMs,
        allowedHosts: config.allowedImageHosts,
        denyPrivate: !config.allowPrivateImageHosts,
      });
      nimRequest = inlined.request;
      notes.push(...inlined.notes);
    } catch (err) {
      if (err instanceof ImageFetchError) {
        throw new ProxyError(err.message, { status: err.status, type: 'invalid_request_error', cause: err });
      }
      throw err;
    }
  } else if (!config.inlineRemoteImages && hasImageContent(built.messages)
    && built.messages.some((m) => Array.isArray(m?.content)
      && m.content.some((p) => p?.type === 'image_url' && /^https?:\/\//i.test(p?.image_url?.url || '')))) {
    notes.push('remote image URL passed through as-is; NVIDIA may reject it (set INLINE_REMOTE_IMAGES=true)');
  }
  const abort = linkClientAbort(req, res);

  logger.info(`[${req.id}] → ${nimRequest.model} | stream=${wantsStream} | max_tokens=${nimRequest.max_tokens} | key=${callerKey.source === 'pool' ? 'pool' : 'caller'}${notes.length ? ` | notes=${notes.join(';')}` : ''}`);

  const callOpts = {
    path: '/chat/completions',
    body: nimRequest,
    signal: abort.signal,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
  };
  if (callerKey.key) callOpts.apiKey = callerKey.key;

  const logBase = {
    reqId: req.id, method: req.method, path: req.path, model: nimRequest.model,
    stream: wantsStream, endpoint: shape === 'legacy' ? 'completions' : 'chat',
    clientIp: clientIp(req), userAgent: req.headers['user-agent'],
    keySource: callerKey.source,
  };

  if (debugHeadersEnabled(req.query)) {
    res.setHeader('X-Proxy-Request-Id', req.id);
    res.setHeader('X-NIM-Model', nimRequest.model);
    if (notes.length) res.setHeader('X-Proxy-Notes', notes.join('; ').replace(/[^\x20-\x7e]/g, '?').slice(0, 200));
  }

  if (wantsStream) {
    const response = await upstream.stream(callOpts);
    const meta = response.__proxyMeta || {};
    if (meta.attempt > 1) res.setHeader('X-Upstream-Retries', String(meta.attempt - 1));

    const stats = await relaySseStream(response.data, res, {
      idleTimeoutMs: config.streamIdleTimeoutMs,
      requestTimedOut: false,
      isClientGone: () => Boolean(abort.abortedBecause),
    });

    abort.settle();
    const usage = stats.usage || {};
    const failed = stats.outcome !== 'done' && stats.outcome !== 'aborted';
    // A clean 200 whose only tokens were reasoning is a blank answer to every
    // ordinary OpenAI client. Nothing throwable happened, so this is a warning
    // rather than an error — but it must be visible.
    const reasoningOnly = !failed && !stats.sawContent && stats.reasoningChars > 0;
    record(requestLog, {
      ...logBase,
      status: stats.outcome === 'aborted' ? 499 : failed ? 502 : 200,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      keyIndex: meta.keyIndex, retries: (meta.attempt || 1) - 1,
      outcome: failed ? stats.outcome : reasoningOnly ? 'reasoning_only' : stats.outcome,
      events: stats.events,
      error: stats.error ? stats.error.message
        : (stats.outcome === 'truncated' ? 'upstream ended without [DONE]'
          : reasoningOnly ? `${stats.reasoningChars} chars of reasoning, no answer content — raise max_tokens` : null),
      startedAt,
    });
    if (reasoningOnly) {
      logger.warn(`[${req.id}] ! stream returned reasoning only (${stats.reasoningChars} chars) — max_tokens=${nimRequest.max_tokens} was exhausted before any answer; this model reasons before it answers`);
    } else if (failed) {
      logger.warn(`[${req.id}] ! stream ${stats.outcome} after ${fmtDuration(Date.now() - startedAt)}: ${stats.error?.message || 'truncated'}`);
    } else {
      logger.info(`[${req.id}] ← stream ${stats.outcome} | ${stats.events} events | ${fmtDuration(Date.now() - startedAt)}`);
    }
    return;
  }

  const response = await upstream.json(callOpts);
  const meta = response.__proxyMeta || {};
  const nim = response.data;

  if (!Array.isArray(nim?.choices) || nim.choices.length === 0) {
    const message = nim?.error?.message || nim?.detail
      || `NVIDIA returned no choices for ${nimRequest.model} — the model may be unavailable or reject these parameters.`;
    record(requestLog, {
      ...logBase, status: 502, keyIndex: meta.keyIndex, retries: (meta.attempt || 1) - 1,
      outcome: 'empty_choices', error: message, startedAt,
    });
    throw new ProxyError(message, { status: 502, type: 'upstream_error' });
  }

  const payload = shape === 'legacy' ? toLegacyCompletion(nim, nimRequest.model) : toChatCompletion(nim, nimRequest.model);

  if (meta.attempt > 1) res.setHeader('X-Upstream-Retries', String(meta.attempt - 1));
  if (debugHeadersEnabled(req.query)) res.setHeader('X-NIM-Tokens', String(payload.usage.total_tokens));

  record(requestLog, {
    ...logBase,
    status: 200,
    promptTokens: payload.usage.prompt_tokens,
    completionTokens: payload.usage.completion_tokens,
    totalTokens: payload.usage.total_tokens,
    keyIndex: meta.keyIndex, retries: (meta.attempt || 1) - 1,
    outcome: 'ok', startedAt,
  });
  // Same blank-answer trap as the streaming path: a reasoning model can spend
  // the whole budget thinking and return finish_reason "length" with no content.
  const choice = payload.choices?.[0];
  if (choice && choice.finish_reason === 'length' && !choice.message?.content
    && (choice.message?.reasoning_content?.length || 0) > 0) {
    logger.warn(`[${req.id}] ! response is reasoning only (finish_reason=length) — max_tokens=${nimRequest.max_tokens} was exhausted before any answer`);
  }
  logger.info(`[${req.id}] ← ${payload.model} | ${payload.usage.total_tokens} tokens | ${fmtDuration(Date.now() - startedAt)}${(meta.attempt || 1) > 1 ? ` | after ${meta.attempt - 1} retr${meta.attempt === 2 ? 'y' : 'ies'}` : ''}`);

  abort.settle();
  res.json(payload);
}

function createChatRouter(deps) {
  const router = express.Router();
  const { requestLog, logger } = deps;

  router.post('/chat/completions', async (req, res, next) => {
    try {
      validateChatRequest(req.body);
      await runCompletion(req, res, deps, { body: req.body, shape: 'chat' });
    } catch (err) {
      if (err instanceof RequestValidationError) return next(new ProxyError(err.message, { status: 400, type: 'invalid_request_error', param: err.param }));
      if (err instanceof ProxyError) {
        record(requestLog, {
          reqId: req.id, method: req.method, path: req.path, model: req.body?.model,
          status: err.status, endpoint: 'chat', outcome: 'error', error: err.message,
          clientIp: clientIp(req), startedAt: req.startedAt,
        });
        logger.error(`[${req.id}] ! ${err.status} ${err.type}: ${err.message}`);
        return res.status(err.status).json(errorBody(err, req.id));
      }
      return next(err);
    }
  });

  // Legacy text completions (FIM / autocomplete models), mapped onto chat.
  router.post('/completions', async (req, res, next) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        throw new RequestValidationError('Request body must be a JSON object');
      }
      let chatBody;
      try {
        chatBody = legacyToChatBody(req.body);
      } catch (err) {
        throw new RequestValidationError(err.message, err.param);
      }
      await runCompletion(req, res, deps, { body: chatBody, shape: 'legacy' });
    } catch (err) {
      if (err instanceof RequestValidationError) return next(new ProxyError(err.message, { status: 400, type: 'invalid_request_error', param: err.param }));
      if (err instanceof ProxyError) {
        record(requestLog, {
          reqId: req.id, method: req.method, path: req.path, model: req.body?.model,
          status: err.status, endpoint: 'completions', outcome: 'error', error: err.message,
          clientIp: clientIp(req), startedAt: req.startedAt,
        });
        return res.status(err.status).json(errorBody(err, req.id));
      }
      return next(err);
    }
  });

  return router;
}

module.exports = { createChatRouter, runCompletion, linkClientAbort, debugHeadersEnabled };
