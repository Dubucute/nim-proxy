// src/errors.js — One error vocabulary for the whole proxy.
//
// The original code built an OpenAI-shaped error object inline in five places,
// typed everything as "invalid_request_error" regardless of cause, leaked
// upstream response bodies, and had a catch path that threw a ReferenceError
// (`nimRequest` was block-scoped to the try). Here the mapping is centralised
// and every branch is reachable.

'use strict';

class ProxyError extends Error {
  constructor(message, { status = 500, type = 'server_error', code = null, param = null, cause = null, headers = null } = {}) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.type = type;
    this.code = code ?? status;
    this.param = param;
    this.headers = headers;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: String(this.code ?? this.status),
      },
    };
  }
}

// NVIDIA's gateway answers some errors as JSON wrapped in `text/plain`, so a
// string body is not automatically a plain message. Try to unwrap it before
// falling back to the raw text, otherwise the client sees a JSON blob nested
// inside an OpenAI error object.
function extractUpstreamMessage(data) {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const inner = parsed?.error?.message || parsed?.detail || parsed?.title || parsed?.message;
        if (inner) return String(inner);
      } catch { /* not JSON after all: fall through to the raw text */ }
    }
    if (!trimmed) return null;
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
  }
  const msg = data?.error?.message || data?.detail || data?.title || data?.message;
  return msg ? String(msg) : null;
}

/** Find the original upstream response, following ProxyError cause chains. */
function upstreamResponse(err, depth = 0) {
  if (!err || depth > 5) return null;
  if (err.response) return err.response;
  return upstreamResponse(err.cause, depth + 1);
}

/** True when the upstream simply has no route for this path (as opposed to rejecting the request). */
function isMissingRoute(err) {
  const response = upstreamResponse(err);
  if (response?.status !== 404) return false;
  const body = extractUpstreamMessage(response.data);
  return !body || /page not found|not found|404/i.test(body);
}

// NVIDIA -> OpenAI error-type mapping. Status comes from upstream when present
// so clients can retry correctly (429/503 are retryable, 400 is not).
function fromUpstream(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const retryAfter = err?.response?.headers?.['retry-after'];

  const upstreamMessage = extractUpstreamMessage(data);

  if (err?.code === 'ECONNABORTED' || err?.name === 'AbortError' && /timeout/i.test(err.message || '')) {
    return new ProxyError(`Upstream request timed out: ${err.message}`, { status: 504, type: 'server_timeout', cause: err });
  }
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ERR_NETWORK'].includes(err?.code)) {
    return new ProxyError(`Cannot reach NVIDIA NIM (${err.code}). Check NIM_API_BASE and network access.`, { status: 502, type: 'upstream_unavailable', cause: err });
  }

  if (status === 401 || status === 403) {
    return new ProxyError('Upstream rejected the configured API key. Verify NIM_API_KEY at build.nvidia.com.', {
      status: 502, type: 'upstream_auth_error', cause: err,
    });
  }
  if (status === 404 || status === 422 || status === 400) {
    // Model/parameter problems are the caller's to fix: pass the status through.
    return new ProxyError(upstreamMessage || err?.message || 'Invalid request for the requested model', {
      status, type: 'invalid_request_error', cause: err,
    });
  }
  // 410 Gone: NVIDIA retired the model. Observed as RFC 7807 problem+json with
  // a `detail` explaining the end-of-life date, e.g. meta/llama-3.1-8b-instruct.
  if (status === 410) {
    const detail = upstreamMessage || 'The requested model has been retired by NVIDIA.';
    return new ProxyError(`${detail} Pick a current model from /v1/models.`, {
      status: 410, type: 'model_unavailable', cause: err,
    });
  }
  if (status === 429) {
    return new ProxyError(upstreamMessage || 'NVIDIA NIM rate limit reached for the configured keys', {
      status: 429, type: 'rate_limit_error', cause: err,
      headers: retryAfter ? { 'Retry-After': String(retryAfter) } : null,
    });
  }
  if (status && status >= 500) {
    return new ProxyError(upstreamMessage || `NVIDIA NIM returned ${status}`, { status: 502, type: 'upstream_error', cause: err });
  }
  // Anything else: prefer what NVIDIA said over axios's generic
  // "Request failed with status code N", which tells a caller nothing.
  return new ProxyError(upstreamMessage || err?.message || 'Unknown upstream error', {
    status: status && status >= 400 && status < 500 ? status : 502,
    type: 'upstream_error',
    cause: err,
  });
}

/** True when the error is a retryable upstream condition. */
function isRetryable(err) {
  const status = err?.response?.status;
  if (status === 429) return true;
  if (status && status >= 500 && status !== 501) return true;
  if (['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_NETWORK'].includes(err?.code)) return true;
  return false;
}

function isRateLimitError(err) {
  if (err?.response?.status === 429) return true;
  const text = `${err?.response?.data?.error?.message || ''} ${err?.response?.statusText || ''} ${err?.message || ''}`;
  return /429|resourceexhausted|rate.?limit|too many requests|tpm|rpm limit/i.test(text);
}

function errorBody(err, reqId) {
  const base = err instanceof ProxyError ? err.toJSON().error : {
    message: err?.message || 'Internal server error',
    type: err?.type || 'server_error',
    param: err?.param ?? null,
    code: String(err?.code ?? err?.status ?? 500),
  };
  return { error: { ...base, request_id: reqId } };
}

module.exports = { ProxyError, fromUpstream, isRetryable, isRateLimitError, errorBody, extractUpstreamMessage, isMissingRoute, upstreamResponse };
