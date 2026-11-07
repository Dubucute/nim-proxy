// src/routes/passthrough.js — embeddings, images, audio.
//
// The original registered `app.post(endpoint, ...)` handlers that forwarded
// `req.body` verbatim. Two consequences: the caller's `apiKey` travelled to
// NVIDIA inside the JSON body (confirmed by test), and file uploads could not
// work at all — `express.json` only parses JSON, so a multipart transcription
// request reached `req.body` as `{}` while the code still claimed
// `Content-Type: multipart/form-data`.
//
// Now proxy-only fields are stripped, multipart bodies are captured raw and
// relayed byte-for-byte with the caller's original boundary header, and binary
// responses are streamed.

'use strict';

const express = require('express');
const { stripProxyOnlyFields, resolveCallerKey } = require('../translate');
const { ProxyError } = require('../errors');
const { clientIp } = require('../middleware');
const { fmtDuration } = require('../request-log');

// endpoint -> { streamResponse, acceptsMultipart, requireModel }
const ENDPOINTS = {
  '/embeddings': { requireModel: true },
  '/images/generations': { requireModel: true },
  '/images/edits': { acceptsMultipart: true, requireModel: true },
  '/audio/transcriptions': { acceptsMultipart: true, requireModel: false },
  '/audio/translations': { acceptsMultipart: true, requireModel: false },
  '/audio/speech': { streamResponse: true, requireModel: true },
};

function isMultipart(req) {
  return String(req.headers['content-type'] || '').includes('multipart/form-data');
}

function createPassthroughRouter(deps) {
  const router = express.Router();
  const { config, upstream, keyPool, requestLog, logger } = deps;

  for (const [suffix, spec] of Object.entries(ENDPOINTS)) {
    const handler = async (req, res, next) => {
      const startedAt = Date.now();
      try {
        const callerKey = resolveCallerKey(req, config);
        if (!callerKey.key && keyPool.size === 0) {
          throw new ProxyError('No NVIDIA API key available. Set NIM_API_KEY on the server or send your own key.', {
            status: 503, type: 'server_misconfigured',
          });
        }

        const multipart = isMultipart(req);
        const isBufferBody = Buffer.isBuffer(req.body);

        if (!multipart && (req.body === undefined || req.body === null)) {
          throw new ProxyError('A JSON request body is required', { status: 400, type: 'invalid_request_error' });
        }
        if (multipart && !isBufferBody) {
          throw new ProxyError('Multipart body was not captured; upload larger files as a URL or raise BODY_LIMIT', {
            status: 413, type: 'invalid_request_error',
          });
        }
        if (spec.requireModel && !multipart) {
          if (!req.body?.model) {
            throw new ProxyError('model is required', { status: 400, type: 'invalid_request_error', param: 'model' });
          }
        }
        // OpenAI's embeddings accept a bare string; NVIDIA wants an array.
        let payload;
        if (multipart) {
          payload = req.body; // raw bytes, relayed untouched
        } else {
          payload = stripProxyOnlyFields(req.body);
          if (suffix === '/embeddings' && typeof payload.input === 'string') payload.input = [payload.input];
        }

        const headers = {};
        if (multipart) headers['Content-Type'] = req.headers['content-type'];
        if (spec.streamResponse) headers.Accept = 'audio/mpeg, application/octet-stream';

        const callOpts = {
          path: suffix,
          body: payload,
          headers,
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        };
        if (callerKey.key) callOpts.apiKey = callerKey.key;

        const response = spec.streamResponse
          ? await upstream.stream(callOpts)
          : await upstream.json(callOpts);
        const meta = response.__proxyMeta || {};

        const duration = Date.now() - startedAt;
        if (spec.streamResponse) {
          const contentType = response.headers?.['content-type'] || 'audio/mpeg';
          res.setHeader('Content-Type', contentType);
          if (response.headers?.['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
          await new Promise((resolve, reject) => {
            response.data.on('error', reject);
            res.on('close', resolve);
            response.data.pipe(res, { end: true });
            response.data.on('end', resolve);
          });
        } else {
          res.json(response.data);
        }

        requestLog.add({
          reqId: req.id, method: req.method, path: req.path,
          model: multipart ? (req.body?.model ?? 'multipart') : req.body?.model,
          status: 200, duration, durationFmt: fmtDuration(duration),
          endpoint: suffix.replace('/', ''), stream: Boolean(spec.streamResponse),
          keyIndex: meta.keyIndex, retries: (meta.attempt || 1) - 1,
          outcome: 'ok', clientIp: clientIp(req),
        });
        logger.info(`[${req.id}] ← ${suffix} | ${fmtDuration(duration)}${multipart ? ' | multipart' : ''}`);
        return undefined;
      } catch (err) {
        const status = err instanceof ProxyError ? err.status : 500;
        requestLog.add({
          reqId: req.id, method: req.method, path: req.path, model: req.body?.model,
          status, duration: Date.now() - startedAt, durationFmt: fmtDuration(Date.now() - startedAt),
          endpoint: suffix.replace('/', ''), outcome: 'error', error: err.message,
          clientIp: clientIp(req),
        });
        return next(err);
      }
    };

    router.post(suffix, handler);
    // `express.raw` body capture is installed per-route in app.js; the handler
    // above works with either a Buffer (multipart) or an object (JSON).
  }

  return router;
}

module.exports = { createPassthroughRouter, ENDPOINTS, isMultipart };
