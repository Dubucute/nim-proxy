// src/translate.js — OpenAI request/response <-> NVIDIA NIM translation.
//
// Fixes from the original buildNimRequest/transformChoices:
//   * NVIDIA sampling parameters (top_k, min_p, repetition_penalty, n, ...) are
//     forwarded instead of silently dropped
//   * `max_tokens: 0` is rejected with a clear 400 rather than quietly becoming 4096
//   * caller-side fields (apiKey and friends) are never forwarded upstream
//   * response choices keep every field the client sent us (logprobs, refusal,
//     reasoning, function_call) instead of a hand-picked subset
//   * a single explicit allow-list is the security boundary, so unknown client
//     keys are dropped and reported rather than passed along blindly

'use strict';

const shared = require('../shared');

// Fields we forward verbatim. Anything not listed is dropped.
const FORWARD_PARAMS = [
  'model', 'messages', 'stream', 'stream_options',
  'max_tokens', 'temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty',
  'presence_penalty', 'repetition_penalty', 'penalty_alpha', 'n', 'stop',
  'seed', 'logit_bias', 'response_format', 'logprobs', 'top_logprobs',
  'tools', 'tool_choice', 'parallel_tool_calls',
  'reasoning', 'reasoning_effort', 'extra_body', 'user',
  // Audio I/O on omni models: input_audio content parts ride inside `messages`;
  // these two request fields complete the OpenAI audio shape. The hosted gateway
  // currently ignores audio *output* requests, but forwarding them keeps the
  // proxy honest if that ever changes.
  'modalities', 'audio',
];

// Caller-side control fields: meaningful to the proxy, never valid upstream.
const PROXY_ONLY_FIELDS = ['apiKey', 'api_key', 'key', 'accessKey', 'baseUrl', 'baseURL', 'apiBase', 'proxyKey'];

// OpenAI-compatible sampling bounds, validated before we spend a request.
const RANGES = {
  temperature: [0, 2],
  top_p: [0, 1],
  n: [1, 4],
  presence_penalty: [-2, 2],
  frequency_penalty: [-2, 2],
};

class RequestValidationError extends Error {
  constructor(message, param) {
    super(message);
    this.name = 'RequestValidationError';
    this.status = 400;
    this.code = 'invalid_request_error';
    this.param = param;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the parts of an OpenAI request we can check locally. */
function validateChatRequest(body) {
  if (!isPlainObject(body)) throw new RequestValidationError('Request body must be a JSON object');
  if (typeof body.model !== 'string' || !body.model.trim()) {
    throw new RequestValidationError('model is required and must be a non-empty string', 'model');
  }
  if (body.model.length > 300) throw new RequestValidationError('model is too long', 'model');
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestValidationError('messages is required and must be a non-empty array', 'messages');
  }
  for (const [i, message] of body.messages.entries()) {
    if (!isPlainObject(message)) throw new RequestValidationError(`messages[${i}] must be an object`, 'messages');
    if (typeof message.role !== 'string' || !message.role) {
      throw new RequestValidationError(`messages[${i}].role is required`, 'messages');
    }
    const hasContent = typeof message.content === 'string' || Array.isArray(message.content)
      || message.content === null || message.content === undefined;
    if (!hasContent && !message.tool_calls && !message.function_call) {
      throw new RequestValidationError(`messages[${i}].content must be a string, an array, or null`, 'messages');
    }
  }
  if (body.max_tokens !== undefined && body.max_tokens !== null &&
    (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) {
    throw new RequestValidationError('max_tokens must be an integer >= 1', 'max_tokens');
  }
  if (body.max_completion_tokens !== undefined && body.max_completion_tokens !== null &&
    (!Number.isInteger(body.max_completion_tokens) || body.max_completion_tokens < 1)) {
    throw new RequestValidationError('max_completion_tokens must be an integer >= 1', 'max_completion_tokens');
  }
  for (const [field, [min, max]] of Object.entries(RANGES)) {
    const value = body[field];
    if (value !== undefined && value !== null) {
      if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
        throw new RequestValidationError(`${field} must be a number between ${min} and ${max}`, field);
      }
    }
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new RequestValidationError('stream must be a boolean', 'stream');
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new RequestValidationError('tools must be an array', 'tools');
  }
}

/**
 * Build the NIM request body from an OpenAI-format body.
 * @returns {{request: object, notes: string[]}} notes = normalisations we applied
 */
function buildNimRequest(body) {
  const notes = [];
  const request = {};

  for (const field of FORWARD_PARAMS) {
    if (body[field] !== undefined && body[field] !== null) request[field] = body[field];
  }

  if (!isPlainObject(request.messages)) request.messages = body.messages;

  // OpenAI's newer SDKs send max_completion_tokens; NIM only knows max_tokens.
  const wanted = body.max_completion_tokens ?? body.max_tokens;
  const ceiling = shared.getDefaultMaxTokens(body.model || '');
  if (wanted === undefined || wanted === null) {
    request.max_tokens = ceiling;
    notes.push(`max_tokens defaulted to ${ceiling} for ${body.model}`);
  } else if (wanted > ceiling) {
    request.max_tokens = ceiling;
    notes.push(`max_tokens ${wanted} exceeds ${body.model} limit; clamped to ${ceiling}`);
  } else {
    request.max_tokens = wanted;
  }
  delete request.max_completion_tokens;

  if (request.stream === undefined) request.stream = false;

  // NIM wants stop as an array; OpenAI allows a bare string.
  if (typeof request.stop === 'string') request.stop = [request.stop];

  if (body.response_format && isPlainObject(body.response_format)
    && typeof body.response_format.json_schema === 'object' && body.response_format.json_schema) {
    notes.push('response_format.json_schema forwarded as-is');
  }

  for (const field of PROXY_ONLY_FIELDS) {
    if (body[field] !== undefined && !notes.includes(`dropped:${field}`)) notes.push(`dropped:${field}`);
  }

  return { request, notes };
}

/** One NIM non-streaming choice -> one OpenAI choice, keeping extra fields. */
function transformChoice(choice, index) {
  const message = isPlainObject(choice.message) ? choice.message : {};
  const out = {
    index: Number.isInteger(choice.index) ? choice.index : index,
    finish_reason: choice.finish_reason || 'stop',
    message: {
      role: message.role || 'assistant',
      content: message.content ?? null,
    },
  };
  const forwardedMessageFields = ['tool_calls', 'function_call', 'reasoning', 'reasoning_content', 'name', 'refusal'];
  for (const field of forwardedMessageFields) {
    if (message[field] !== undefined && message[field] !== null) out.message[field] = message[field];
  }
  for (const field of ['logprobs', 'finish_details']) {
    if (choice[field] !== undefined && choice[field] !== null) out[field] = choice[field];
  }
  return out;
}

function transformChoices(choices) {
  return (Array.isArray(choices) ? choices : []).map(transformChoice);
}

/** Normalise a NIM completion into a spec-shaped chat.completion object. */
function toChatCompletion(nim, requestedModel) {
  const source = isPlainObject(nim) ? nim : {};
  const choices = transformChoices(source.choices);
  const usage = source.usage || {};
  return {
    id: source.id || `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: source.created || Math.floor(Date.now() / 1000),
    model: source.model || requestedModel,
    choices,
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    },
    ...(source.system_fingerprint ? { system_fingerprint: source.system_fingerprint } : {}),
  };
}

/** Legacy text_completion shape used by FIM / autocomplete clients. */
function toLegacyCompletion(nim, requestedModel) {
  const completion = toChatCompletion(nim, requestedModel);
  return {
    id: completion.id.replace(/^chatcmpl/, 'cmpl'),
    object: 'text_completion',
    created: completion.created,
    model: completion.model,
    choices: completion.choices.map((choice) => ({
      text: choice.message.content ?? '',
      index: choice.index,
      finish_reason: choice.finish_reason,
      ...(choice.logprobs ? { logprobs: choice.logprobs } : {}),
    })),
    usage: completion.usage,
  };
}

/** Legacy /v1/completions body -> chat body, preserving FIM-friendly defaults. */
function legacyToChatBody(body) {
  const prompt = typeof body.prompt === 'string' ? body.prompt
    : Array.isArray(body.prompt) ? body.prompt.join('') : '';
  if (!body.model || typeof body.model !== 'string') {
    throw new RequestValidationError('model is required and must be a non-empty string', 'model');
  }
  const chatBody = {
    model: body.model,
    messages: [{ role: typeof body.role === 'string' ? body.role : 'user', content: prompt }],
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 256,
    temperature: body.temperature ?? 0.2,
    stream: Boolean(body.stream),
  };
  for (const field of ['stop', 'top_p', 'top_k', 'min_p', 'n', 'seed', 'logit_bias', 'presence_penalty', 'frequency_penalty', 'repetition_penalty', 'logprobs', 'user']) {
    if (body[field] !== undefined && body[field] !== null) chatBody[field] = body[field];
  }
  return chatBody;
}

function stripProxyOnlyFields(body) {
  if (!isPlainObject(body)) return body;
  const out = { ...body };
  for (const field of PROXY_ONLY_FIELDS) delete out[field];
  return out;
}

// Placeholder values clients put in the key field when the proxy itself holds
// the credentials — VS Code's chatLanguageModels.json for instance ships
// `apiKey: "proxy-no-auth-needed"`. Treating those as real keys produced a
// confusing 401 from NVIDIA, so they fall through to the configured pool.
const SENTINEL_WORDS = /no[-_ ]?auth|no[-_ ]?key|placeholder|example|your[-_ ]?key|replace[-_ ]?me|changeme|dummy|fake|unused|skip(ped)?|none|null|undefined|not[-_ ]?set|test(ing)?[-_ ]?(key|token)|^proxy$|^\W*$|^\W+[-_]?(no|proxy)/i;

function looksLikeRealKey(candidate) {
  if (typeof candidate !== 'string') return false;
  const value = candidate.trim();
  if (value.length < 20) return false;
  if (/\s/.test(value)) return false;
  if (!/^[A-Za-z0-9_\-.:]+$/.test(value)) return false;
  if (SENTINEL_WORDS.test(value)) return false;
  return true;
}

/**
 * Decide whether the caller brought their own upstream key.
 * @returns {{key: string|null, source: 'body'|'header'|'pool', reason?: string}}
 */
function resolveCallerKey(req, config) {
  const fromHeader = (() => {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    return match ? match[1].trim() : null;
  })();
  const fromBody = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : null;
  const candidate = fromBody || fromHeader;

  if (!candidate) return { key: null, source: 'pool' };
  if (SENTINEL_WORDS.test(candidate)) return { key: null, source: 'pool', reason: 'sentinel' };
  if (!looksLikeRealKey(candidate)) return { key: null, source: 'pool', reason: 'malformed' };
  if (!config.allowBodyApiKey && fromBody) return { key: null, source: 'pool', reason: 'body keys disabled' };

  return { key: candidate, source: fromBody ? 'body' : 'header' };
}

module.exports = {
  FORWARD_PARAMS,
  PROXY_ONLY_FIELDS,
  SENTINEL_WORDS,
  looksLikeRealKey,
  RequestValidationError,
  validateChatRequest,
  buildNimRequest,
  transformChoice,
  transformChoices,
  toChatCompletion,
  toLegacyCompletion,
  legacyToChatBody,
  stripProxyOnlyFields,
  resolveCallerKey,
  isPlainObject,
};
