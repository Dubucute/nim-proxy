// server.js - OpenAI to NVIDIA NIM API Proxy
// Translates between VS Code's OpenAI-format requests and NVIDIA NIM format
require('dotenv').config();
const https = require('https');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const axios = require('axios');
const shared = require('./shared');

// KeepAlive agent — reuses TCP/TLS connections to NVIDIA instead of handshaking per request
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
axios.defaults.httpsAgent = keepAliveAgent;

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(compression({ threshold: 512 })); // compress responses > 512 bytes
app.use(cors());

// ── Request Log ──────────────────────────────────────────────────────────────
// Circular buffer — stores last 500 proxy requests with timing, status, tokens
const requestLog = [];
const MAX_LOG_ENTRIES = 500;

function addLogEntry(entry) {
  requestLog.push({
    timestamp: new Date().toISOString(),
    timeLocal: new Date().toLocaleString(),
    ...entry
  });
  if (requestLog.length > MAX_LOG_ENTRIES) requestLog.shift();
}

// Format duration in ms to a readable string
function fmtDuration(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 1000).toFixed(0)}s`;
}
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';

// Rotating pool of API keys — if one hits rate limit, next key is used
// Set NIM_API_KEY in env, optionally add NIM_API_KEY_2, _3, _4, etc.
// Falls back to hardcoded keys for convenience.
const NIM_API_KEYS = (() => {
  const keys = [];
  // Collect all NIM_API_KEY* env vars
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NIM_API_KEY') && value) {
      keys.push(value);
    }
  }
  if (keys.length === 0) {
    console.error('[FATAL] No NIM_API_KEY environment variable set!');
    console.error('Set NIM_API_KEY in your .env file or environment.');
  }
  return keys;
})();
// Advanced key manager — tracks rate limit cooldowns per key, auto-skips throttled keys
const keyManager = {
  keys: NIM_API_KEYS,
  index: 0,
  cooldowns: {},        // { index: timestamp_ms } when cooldown expires
  COOLDOWN_MS: 30000,   // 30 seconds cooldown after rate limit

  // Get the best available key (skips keys in cooldown)
  get() {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.index + i) % this.keys.length;
      if (!this.cooldowns[idx] || now >= this.cooldowns[idx]) {
        this.index = idx;
        return this.keys[idx];
      }
    }
    // All keys cooling down — use current anyway (better than nothing)
    return this.keys[this.index];
  },

  // Mark a key as rate limited and move to next healthy key
  markRateLimited(keyIdx) {
    const idx = keyIdx !== undefined ? keyIdx : this.index;
    this.cooldowns[idx] = Date.now() + this.COOLDOWN_MS;
    console.log(`[PROXY] Key #${idx + 1} rate limited — cooldown ${this.COOLDOWN_MS / 1000}s`);
    // Move to next key that isn't cooling down
    const now = Date.now();
    for (let i = 1; i <= this.keys.length; i++) {
      const nextIdx = (idx + i) % this.keys.length;
      if (!this.cooldowns[nextIdx] || now >= this.cooldowns[nextIdx]) {
        this.index = nextIdx;
        return;
      }
    }
    // All cooling down — just move to next sequentially
    this.index = (idx + 1) % this.keys.length;
  },

  // Check if all keys are currently in cooldown
  allCoolingDown() {
    const now = Date.now();
    return this.keys.length > 0 && this.keys.every((_, i) => this.cooldowns[i] && now < this.cooldowns[i]);
  }
};

// Convenience wrapper — matches old getCurrentKey() signature
function getCurrentKey() {
  return keyManager.get();
}

function rotateKey() {
  if (NIM_API_KEYS.length === 0) return;
  keyManager.markRateLimited(keyManager.index);
}

// Request ID generator for log tracing
let requestCounter = 0;
function nextRequestId() {
  return `req-${Date.now()}-${++requestCounter}`;
}

// Resolve which API key to use for a given request.
// Priority: 1) req.body.apiKey (if non-empty and not "none"), 2) rotating pool
// Returns null if no keys configured at all (handled downstream with a clear error)
function resolveApiKey(req) {
  if (req && req.body && req.body.apiKey && typeof req.body.apiKey === 'string' && req.body.apiKey.trim() !== '' && req.body.apiKey.toLowerCase() !== 'none') {
    return req.body.apiKey.trim();
  }
  return getCurrentKey();
}

// Check if any API keys are configured — used for fast-fail validation
function hasApiKeysConfigured() {
  return NIM_API_KEYS.length > 0;
}

// Whitelist of params to forward from incoming request to NVIDIA
const FORWARD_PARAMS = [
  'model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream',
  'temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty',
  'tools', 'tool_choice', 'parallel_tool_calls',
  'response_format', 'stream_options',
  'seed', 'user', 'logit_bias'
];

// Endpoints that are proxied directly to NVIDIA (passthrough — no transformation needed)
// Note: NVIDIA's integrate.api.nvidia.com API may not have all audio models available.
const PASSTHROUGH_ENDPOINTS = [
  '/v1/embeddings',
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/audio/transcriptions',
  '/v1/audio/translations',
  '/v1/audio/speech'
];

// Build an NVIDIA NIM request body from an incoming OpenAI-format body
function buildNimRequest(body) {
  const nimRequest = {};
  for (const key of FORWARD_PARAMS) {
    if (body[key] !== undefined && body[key] !== null) {
      nimRequest[key] = body[key];
    }
  }
  // Map OpenAI's max_completion_tokens to NVIDIA's max_tokens
  // max_completion_tokens takes precedence (newer SDKs use it exclusively)
  if (body.max_completion_tokens !== undefined && body.max_completion_tokens !== null) {
    nimRequest.max_tokens = body.max_completion_tokens;
  }
  if (!nimRequest.max_tokens) nimRequest.max_tokens = shared.getDefaultMaxTokens(body.model || '');
  if (!nimRequest.stream) nimRequest.stream = false;
  return nimRequest;
}

// Transform NIM response choices to OpenAI-compatible format
function transformChoices(choices) {
  return (choices || []).map(choice => {
    const msg = {
      role: choice.message?.role || 'assistant',
      content: choice.message?.content || null
    };
    if (choice.message?.tool_calls) {
      msg.tool_calls = choice.message.tool_calls;
    }
    if (choice.message?.reasoning_content) {
      msg.reasoning_content = choice.message.reasoning_content;
    }
    return {
      index: choice.index,
      message: msg,
      finish_reason: choice.finish_reason || 'stop'
    };
  });
}

// Pipe an NVIDIA NIM streaming response to the client with proper SSE formatting
// Strips nvext metadata, ensures exactly one [DONE] sent, handles buffer accumulation
// Optional onDone callback fires when the stream ends cleanly
function pipeNimStream(nimStream, res, onDone) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let buffer = '';
  let doneSent = false;

  nimStream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    lines.forEach(line => {
      if (line.startsWith('data: ')) {
        if (line.includes('[DONE]')) {
          if (!doneSent) {
            res.write(line + '\n');
            doneSent = true;
          }
          return;
        }
        try {
          const data = JSON.parse(line.slice(6));
          delete data.nvext;
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
          res.write(line + '\n');
        }
      }
    });
  });

  nimStream.on('end', () => {
    if (!doneSent) {
      res.write('data: [DONE]\n\n');
    }
    if (typeof onDone === 'function') onDone();
    res.end();
  });

  nimStream.on('error', (err) => {
    console.error('Stream error:', err);
    if (!doneSent) {
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
}

// Health check endpoint — lists all available endpoints + benchmark summary
app.get('/health', (req, res) => {
  const benchData = shared.loadBenchmarkData();
  const summary = shared.getBenchmarkSummary(benchData);
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    endpoints: {
      chat: '/v1/chat/completions',
      embeddings: '/v1/embeddings',
      images: '/v1/images/generations',
      models: '/v1/models',
      ranked: '/v1/models/ranked'
    },
    benchmarks: summary ? {
      lastUpdated: summary.lastUpdated,
      totalTested: summary.totalTested,
      working: summary.working,
      failed: summary.failed,
      topModel: summary.topModel,
      topScore: summary.topScore,
      fastestModel: summary.fastestModel,
      fastestTime: summary.fastestTime
    } : { status: 'no_benchmark_data' }
  });
});

// Cache for model list
let modelsCache = { data: [], lastFetched: 0 };
const MODELS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Fetch all models from NVIDIA NIM API — no filtering, show everything
async function fetchModelsFromNvidia(retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(`${NIM_API_BASE}/models`, {
        headers: {
          'Authorization': `Bearer ${getCurrentKey()}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      // Include ALL models from NVIDIA, annotated with capabilities — no sorting (raw list)
      modelsCache.data = (response.data.data || [])
        .map(model => {
        const modelType = shared.getModelType(model.id);
        return {
          id: model.id,
          object: 'model',
          created: model.created || Math.floor(Date.now() / 1000),
          owned_by: model.owned_by || 'nvidia',
          type: modelType,
          capabilities: {
            chat: modelType === 'chat',
            embedding: modelType === 'embedding',
            image: modelType === 'image',
            audio: modelType === 'audio',
            toolCalling: modelType === 'chat',
            vision: shared.getVisionCapability(model.id)
          }
        };
      });
      modelsCache.lastFetched = Date.now();
      console.log(`[PROXY] Fetched ${modelsCache.data.length} models from NVIDIA`);
      return; // success
    } catch (error) {
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`[PROXY] Failed to fetch models (attempt ${attempt}/${retries}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error('[PROXY] Failed to fetch models from NVIDIA:', error.message);
      }
    }
  }
}

// List models endpoint (OpenAI compatible) — dynamically fetched from NVIDIA + benchmark annotations
app.get('/v1/models', async (req, res) => {
  // Refresh cache if stale or empty
  if (modelsCache.data.length === 0 || Date.now() - modelsCache.lastFetched > MODELS_CACHE_TTL) {
    await fetchModelsFromNvidia();
  }

  // Load benchmark data for annotations
  const benchData = shared.loadBenchmarkData();
  const lookup = benchData.lookup || {};

  // Annotate each model with benchmark data if available
  let annotatedData = modelsCache.data.map(m => {
    const bench = lookup[m.id];
    if (bench) {
      return {
        ...m,
        benchmark: {
          rank: bench.rank,
          combinedScore: bench.combinedScore,
          speed: bench.speed?.responseTimeSec,
          speedRank: bench.speed?.rank,
          codingScore: bench.coding?.score,
          codingPercentage: bench.coding?.percentage,
          tasksPassed: bench.coding?.tasksPassed
        }
      };
    }
    return m;
  });

  // Filter by model type if requested (e.g. ?type=chat, ?type=embedding, ?type=image, ?type=audio)
  const { type } = req.query;
  if (type) {
    const typeLower = type.toLowerCase();
    annotatedData = annotatedData.filter(m => m.type === typeLower);
  }

  // If still empty after fetch, return fallback
  if (annotatedData.length === 0) {
    const fallback = {
      id: 'meta/llama-3.1-8b-instruct',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'nvidia-nim-proxy',
      type: 'chat',
      capabilities: {
        chat: true,
        embedding: false,
        image: false,
        audio: false,
        toolCalling: true,
        vision: false
      }
    };
    return res.json({
      object: 'list',
      total: modelsCache.data.length > 0 ? annotatedData.length : 1,
      data: modelsCache.data.length > 0 ? [] : [fallback]
    });
  }

  res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=3600');
  res.json({
    object: 'list',
    total: annotatedData.length,
    data: annotatedData
  });
});

// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  const reqId = nextRequestId();
  const startTime = Date.now();
  try {
    // Validate required fields
    if (!req.body.model) {
      return res.status(400).json({
        error: { message: 'model is required', type: 'invalid_request_error', code: 400 }
      });
    }
    if (!req.body.messages || !Array.isArray(req.body.messages) || req.body.messages.length === 0) {
      return res.status(400).json({
        error: { message: 'messages is required and must be a non-empty array', type: 'invalid_request_error', code: 400 }
      });
    }

    // Check if API keys are configured (skip check if user provides their own key)
    if (!hasApiKeysConfigured() && !(req.body.apiKey && typeof req.body.apiKey === 'string' && req.body.apiKey.trim() !== '' && req.body.apiKey.toLowerCase() !== 'none')) {
      return res.status(500).json({
        error: { message: 'NVIDIA API key not configured. Set NIM_API_KEY environment variable or pass an apiKey in the request body.', type: 'server_error', code: 500 }
      });
    }

    // Log a summary of what we received
    const hasTools = !!(req.body.tools && req.body.tools.length > 0);
    console.log(`[${reqId}] → ${req.body.model} | stream: ${req.body.stream} | tokens: ${req.body.max_tokens || 4096} | tools: ${hasTools}`);

    // Build NVIDIA NIM request from incoming OpenAI-format request
    const nimRequest = buildNimRequest(req.body);

    // All models are tool-capable by default — NVIDIA will return errors if not supported

    // Determine which API key to use (custom key from request body, or rotating pool)
    const activeKey = resolveApiKey(req);

    // Make request to NVIDIA NIM API — let NVIDIA decide if the model supports chat
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${activeKey}`,
        'Content-Type': 'application/json'
      },
      responseType: nimRequest.stream ? 'stream' : 'json',
      timeout: 120000
    });

    if (nimRequest.stream) {
      // Set debug headers before SSE stream starts
      if (req.query.debug === 'true') {
        res.setHeader('X-Proxy-Request-Id', reqId);
        res.setHeader('X-NIM-Model', nimRequest.model);
      }
      pipeNimStream(response.data, res, () => {
        const dur = Date.now() - startTime;
        addLogEntry({
          reqId, model: nimRequest.model, status: 200,
          duration: dur, durationFmt: fmtDuration(dur),
          promptTokens: 0, completionTokens: 0, totalTokens: 0,
          stream: true, endpoint: 'chat'
        });
      });
    } else {
      // Transform NIM response to clean OpenAI format
      const openaiResponse = {
        id: response.data.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: response.data.created || Math.floor(Date.now() / 1000),
        model: nimRequest.model,
        system_fingerprint: response.data.system_fingerprint || null,
        choices: transformChoices(response.data.choices),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      console.log(`[${reqId}] ← ${nimRequest.model} | ${openaiResponse.usage.total_tokens} tokens`);

      // Log to request log
      const dur = Date.now() - startTime;
      addLogEntry({
        reqId, model: nimRequest.model, status: 200,
        duration: dur, durationFmt: fmtDuration(dur),
        promptTokens: openaiResponse.usage.prompt_tokens || 0,
        completionTokens: openaiResponse.usage.completion_tokens || 0,
        totalTokens: openaiResponse.usage.total_tokens || 0,
        stream: false, endpoint: 'chat'
      });

      // Debug timing headers — enabled with ?debug=true query param
      if (req.query.debug === 'true') {
        res.setHeader('X-Proxy-Request-Id', reqId);
        res.setHeader('X-NIM-Model', nimRequest.model);
        res.setHeader('X-NIM-Tokens', openaiResponse.usage.total_tokens);
      }

      res.json(openaiResponse);
    }

  } catch (error) {
    console.error(`[${reqId}] Proxy error:`, error.message);

    // Handle rate limiting — mark current key as cooling down, retry with next
    if (error.response?.status === 503 || error.response?.data?.error?.message?.includes('ResourceExhausted') || error.response?.status === 429) {
      const usedKeyIndex = keyManager.index;
      keyManager.markRateLimited(usedKeyIndex);
      // If all keys are now cooling down, give up immediately
      if (keyManager.allCoolingDown()) {
        const dur = Date.now() - startTime;
        addLogEntry({
          reqId, model: nimRequest.model || 'unknown', status: 429,
          duration: dur, durationFmt: fmtDuration(dur),
          promptTokens: 0, completionTokens: 0, totalTokens: 0,
          stream: false, endpoint: 'chat', error: 'all_keys_rate_limited'
        });
        return res.status(429).json({
          error: {
            message: 'All NVIDIA API keys are rate limited. Please wait and try again.',
            type: 'rate_limit_error',
            code: 429
          }
        });
      }
      // Retry with the next available key
      const retryActiveKey = resolveApiKey(req);
      console.log(`[PROXY] Retrying with key #${keyManager.index + 1}...`);
      try {
        const retryNimRequest = buildNimRequest(req.body);
        const retryResponse = await axios.post(`${NIM_API_BASE}/chat/completions`, retryNimRequest, {
          headers: {
            'Authorization': `Bearer ${retryActiveKey}`,
            'Content-Type': 'application/json'
          },
          responseType: req.body.stream ? 'stream' : 'json',
          timeout: 120000
        });
        // Forward the retry response
        if (req.body.stream) {
          if (req.query.debug === 'true') {
            res.setHeader('X-Proxy-Request-Id', reqId);
            res.setHeader('X-NIM-Model', retryNimRequest.model);
            res.setHeader('X-Key-Rotated', 'true');
          }
          pipeNimStream(retryResponse.data, res, () => {
            const dur = Date.now() - startTime;
            addLogEntry({
              reqId, model: retryNimRequest.model, status: 200,
              duration: dur, durationFmt: fmtDuration(dur),
              promptTokens: 0, completionTokens: 0, totalTokens: 0,
              stream: true, endpoint: 'chat', retry: true
            });
          });
        } else {
          const openaiResponse = {
            id: retryResponse.data.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: retryResponse.data.created || Math.floor(Date.now() / 1000),
            model: retryNimRequest.model,
            system_fingerprint: retryResponse.data.system_fingerprint || null,
            choices: transformChoices(retryResponse.data.choices),
            usage: retryResponse.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
          };
          console.log(`[${reqId}] ← ${retryNimRequest.model} (after rotate) | ${openaiResponse.usage.total_tokens} tokens`);
          if (req.query.debug === 'true') {
            res.setHeader('X-Proxy-Request-Id', reqId);
            res.setHeader('X-NIM-Model', retryNimRequest.model);
            res.setHeader('X-Key-Rotated', 'true');
          }
          const dur = Date.now() - startTime;
          addLogEntry({
            reqId, model: retryNimRequest.model, status: 200,
            duration: dur, durationFmt: fmtDuration(dur),
            promptTokens: openaiResponse.usage.prompt_tokens || 0,
            completionTokens: openaiResponse.usage.completion_tokens || 0,
            totalTokens: openaiResponse.usage.total_tokens || 0,
            stream: false, endpoint: 'chat', retry: true
          });
          return res.json(openaiResponse);
        }
      } catch (retryError) {
        console.error(`[${reqId}] Retry also failed:`, retryError.message);
        addLogEntry({
          reqId, model: nimRequest.model || 'unknown', status: 429,
          duration: Date.now() - startTime, durationFmt: fmtDuration(Date.now() - startTime),
          promptTokens: 0, completionTokens: 0, totalTokens: 0,
          stream: false, endpoint: 'chat', error: 'retry_failed'
        });
        return res.status(429).json({
          error: {
            message: 'All NVIDIA API keys are rate limited. Please wait and try again.',
            type: 'rate_limit_error',
            code: 429
          }
        });
      }
    }

    const errStatus = error.response?.status || 500;
    addLogEntry({
      reqId, model: req.body.model || 'unknown', status: errStatus,
      duration: Date.now() - startTime, durationFmt: fmtDuration(Date.now() - startTime),
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      stream: false, endpoint: 'chat', error: error.message
    });

    res.status(errStatus).json({
      error: {
        message: error.response?.data?.error?.message || error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});



// Ranked models endpoint — benchmark-driven ranking with real data from benchmark_data.json
app.get('/v1/models/ranked', async (req, res) => {
  // Fetch models from NVIDIA if cache is empty
  if (modelsCache.data.length === 0 || Date.now() - modelsCache.lastFetched > MODELS_CACHE_TTL) {
    await fetchModelsFromNvidia();
  }

  if (modelsCache.data.length === 0) {
    return res.status(503).json({
      error: {
        message: 'Model data not available.',
        type: 'server_error',
        code: 503
      }
    });
  }

  // Load benchmark data
  const benchData = shared.loadBenchmarkData();
  const lookup = benchData.lookup || {};

  // Sort by benchmark rank (ranked first, then instruct, then alphabetical)
  let sorted = [...modelsCache.data];
  shared.getRankedSort(sorted, lookup);

  // Filter by model type if requested (e.g. ?type=chat, ?type=embedding, ?type=image)
  const { limit, minScore, category, tag, type } = req.query;
  if (type) {
    const typeLower = type.toLowerCase();
    sorted = sorted.filter(m => m.type === typeLower);
  }

  // Annotate each model with benchmark data
  const annotated = sorted.map(m => {
    const bench = lookup[m.id];
    if (bench) {
      return {
        ...m,
        benchmark: {
          rank: bench.rank,
          combinedScore: bench.combinedScore,
          speed: bench.speed?.responseTimeSec,
          speedRank: bench.speed?.rank,
          codingScore: bench.coding?.score,
          codingPercentage: bench.coding?.percentage,
          tasksPassed: bench.coding?.tasksPassed
        }
      };
    }
    return m;
  });

  let results = annotated;

  // Filter by tag (e.g. ?tag=fast, ?tag=vision, ?tag=slow, ?tag=smart)
  // Checks both model tags AND speed rank tags from benchmark data
  if (tag) {
    const tagLower = tag.toLowerCase();
    // First check if it's a capability filter (vision, toolcalling)
    if (tagLower === 'vision') {
      results = results.filter(m => m.capabilities.vision);
    } else if (tagLower === 'toolcalling' || tagLower === 'tools') {
      results = results.filter(m => m.capabilities.toolCalling);
    } else if (tagLower === 'chat' || tagLower === 'embedding' || tagLower === 'image' || tagLower === 'audio') {
      results = results.filter(m => m.type === tagLower);
    } else {
      // Benchmark tag filter — checks speed rank and computed tags from available data
      results = results.filter(m => {
        const bench = m.benchmark;
        if (!bench) return false;
        // Check speed rank
        if ((bench.speedRank || '').toLowerCase().includes(tagLower)) return true;
        // Check combinedScore level for generic tag matching
        if (tagLower === 'coding_expert' && (bench.codingPercentage || 0) >= 80) return true;
        if (tagLower === 'smart' && (bench.codingPercentage || 0) >= 80) return true;
        if (tagLower === 'top_tier' && (bench.combinedScore || 0) > 0) return true;
        if (tagLower === 'best_overall' && (bench.combinedScore || 0) >= 8000) return true;
        return false;
      });
    }
  }

  // Filter by minimum combined score (e.g. ?minScore=8000)
  if (minScore !== undefined && minScore !== null) {
    const min = parseInt(minScore);
    if (!isNaN(min)) {
      results = results.filter(m => (m.benchmark?.combinedScore || 0) >= min);
    }
  }

  // Filter by category from benchmark data (e.g. ?category=fastest, ?category=smartest, ?category=codingExperts)
  if (category) {
    const categories = benchData.raw?.categories || {};
    const allowed = categories[category];
    if (allowed && allowed.length > 0) {
      const allowedSet = new Set(allowed);
      results = results.filter(m => allowedSet.has(m.id));
    }
  }

  // Apply limit
  if (limit !== undefined && limit !== null) {
    const lim = parseInt(limit);
    if (!isNaN(lim) && lim > 0) results = results.slice(0, lim);
  }

  // Count benchmarked vs unranked
  const rankedCount = results.filter(m => m.benchmark).length;

  res.setHeader('Cache-Control', 'public, max-age=900, stale-while-revalidate=3600');
  res.json({
    object: 'list',
    total: sorted.length,
    benchmarkedCount: rankedCount,
    query: { limit, minScore, category, tag, type },
    data: results
  });
});

// Generic passthrough proxy for non-chat endpoints (embeddings, images, audio, etc.)
// These endpoints are forwarded directly to NVIDIA with minimal transformation.
for (const endpoint of PASSTHROUGH_ENDPOINTS) {
  app.post(endpoint, async (req, res) => {
    const reqId = nextRequestId();
    const startTime = Date.now();
    try {
      console.log(`[${reqId}] → ${endpoint} | model: ${req.body.model || 'N/A'}`);

      const passthroughKey = resolveApiKey(req);

      const response = await axios.post(`${NIM_API_BASE}${endpoint}`, req.body, {
        headers: {
          'Authorization': `Bearer ${passthroughKey}`,
          'Content-Type': req.body.file ? 'multipart/form-data' : 'application/json'
        },
        timeout: 120000,
        responseType: endpoint === '/v1/audio/speech' ? 'stream' : 'json'
      });

      if (endpoint === '/v1/audio/speech') {
        // Audio speech returns raw audio stream
        res.setHeader('Content-Type', response.headers['content-type'] || 'audio/mpeg');
        response.data.pipe(res);
      } else {
        console.log(`[${reqId}] ← ${endpoint} | ${(Date.now() - startTime) / 1000}s`);
        const dur = Date.now() - startTime;
        addLogEntry({
          reqId, model: req.body.model || endpoint, status: 200,
          duration: dur, durationFmt: fmtDuration(dur),
          promptTokens: 0, completionTokens: 0, totalTokens: 0,
          stream: false, endpoint
        });
        res.json(response.data);
      }
    } catch (error) {
      console.error(`[${reqId}] ${endpoint} error:`, error.message);
      const errStatus = error.response?.status || 500;
      addLogEntry({
        reqId, model: req.body.model || endpoint, status: errStatus,
        duration: Date.now() - startTime, durationFmt: fmtDuration(Date.now() - startTime),
        promptTokens: 0, completionTokens: 0, totalTokens: 0,
        stream: false, endpoint, error: error.message
      });
      res.status(errStatus).json({
        error: {
          message: error.response?.data?.error?.message || error.message || 'Internal server error',
          type: 'invalid_request_error',
          code: error.response?.status || 500
        }
      });
    }
  });
}

// Legacy completions endpoint (used by autocomplete/FIM models like StarCoder2)
// Converts legacy format to chat completions format for NVIDIA NIM
app.post('/v1/completions', async (req, res) => {
  const reqId = nextRequestId();
  const startTime = Date.now();
  try {
    console.log(`[${reqId}] → ${req.body.model} | legacy completions | tokens: ${req.body.max_tokens || 256}`);

    // Convert legacy format to chat format
    const prompt = req.body.prompt || '';
    const chatBody = {
      model: req.body.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: req.body.max_tokens || 256,
      temperature: req.body.temperature ?? 0.2,
      stop: req.body.stop,
      stream: req.body.stream || false
    };

    const activeKey = resolveApiKey(req);
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, chatBody, {
      headers: {
        'Authorization': `Bearer ${activeKey}`,
        'Content-Type': 'application/json'
      },
      responseType: chatBody.stream ? 'stream' : 'json',
      timeout: 120000
    });

    if (chatBody.stream) {
      pipeNimStream(response.data, res);
    } else {
      // Transform chat completion response to legacy completion format
      const choice = response.data.choices?.[0];
      const legacyResponse = {
        id: response.data.id || `cmpl-${Date.now()}`,
        object: 'text_completion',
        created: response.data.created || Math.floor(Date.now() / 1000),
        model: req.body.model,
        choices: [{
          text: choice?.message?.content || '',
          index: 0,
          finish_reason: choice?.finish_reason || 'stop'
        }],
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      console.log(`[${reqId}] ← ${req.body.model} | ${legacyResponse.usage.total_tokens} tokens`);
      const dur = Date.now() - startTime;
      addLogEntry({
        reqId, model: req.body.model, status: 200,
        duration: dur, durationFmt: fmtDuration(dur),
        promptTokens: legacyResponse.usage.prompt_tokens || 0,
        completionTokens: legacyResponse.usage.completion_tokens || 0,
        totalTokens: legacyResponse.usage.total_tokens || 0,
        stream: false, endpoint: 'completions'
      });
      res.json(legacyResponse);
    }
  } catch (error) {
    console.error(`[${reqId}] Legacy completions error:`, error.message);
    const errStatus = error.response?.status || 500;
    addLogEntry({
      reqId, model: req.body.model || 'unknown', status: errStatus,
      duration: Date.now() - startTime, durationFmt: fmtDuration(Date.now() - startTime),
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      stream: false, endpoint: 'completions', error: error.message
    });
    res.status(errStatus).json({
      error: {
        message: error.response?.data?.error?.message || error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// ── Live Dashboard ──────────────────────────────────────────────────────────
// Shows a real-time table of recent proxy requests — no refresh needed
app.get('/logs', (req, res) => {
  const log = [...requestLog].reverse();
  const total = log.length;
  const ok = log.filter(e => e.status >= 200 && e.status < 300).length;
  const err = log.filter(e => e.status >= 400).length;
  const avgMs = log.length > 0 ? (log.reduce((s, e) => s + e.duration, 0) / log.length).toFixed(0) : 0;
  const byModel = {};
  for (const e of log) {
    byModel[e.model] = (byModel[e.model] || 0) + 1;
  }
  const topModels = Object.entries(byModel).sort((a, b) => b[1] - a[1]).slice(0, 10);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NIM Proxy Dashboard</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px; }
  h1 { font-size:24px; margin-bottom:20px; color:#f0f6fc; }
  .stats { display:flex; gap:16px; margin-bottom:24px; flex-wrap:wrap; }
  .stat-card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px 24px; min-width:120px; }
  .stat-card .num { font-size:28px; font-weight:600; color:#f0f6fc; }
  .stat-card .label { font-size:12px; color:#8b949e; margin-top:4px; text-transform:uppercase; letter-spacing:0.05em; }
  .stat-card.ok .num { color:#3fb950; }
  .stat-card.err .num { color:#f85149; }
  .models { display:flex; gap:8px; margin-bottom:24px; flex-wrap:wrap; }
  .model-tag { background:#21262d; border:1px solid #30363d; border-radius:4px; padding:4px 10px; font-size:12px; color:#8b949e; }
  .model-tag .c { color:#f0f6fc; font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { text-align:left; padding:8px 10px; border-bottom:2px solid #30363d; color:#8b949e; text-transform:uppercase; font-size:11px; letter-spacing:0.05em; }
  td { padding:6px 10px; border-bottom:1px solid #21262d; white-space:nowrap; }
  tr:hover td { background:#161b22; }
  .status { display:inline-block; padding:1px 8px; border-radius:4px; font-weight:600; font-size:11px; }
  .status-2xx { background:#0e4429; color:#3fb950; }
  .status-4xx { background:#492808; color:#d29922; }
  .status-5xx { background:#490202; color:#f85149; }
  .model-name { font-family:'SF Mono','Cascadia Code','Fira Code',monospace; color:#79c0ff; }
  .dur { font-family:'SF Mono',monospace; }
  .tokens { color:#8b949e; }
  .error-msg { color:#f85149; font-size:11px; }
  .time { color:#484f58; font-size:11px; }
  .retry { color:#d29922; font-size:10px; margin-left:4px; }
  .stream-badge { display:inline-block; padding:0 6px; border-radius:3px; font-size:10px; background:#1f2937; color:#8b949e; margin-left:4px; }
  .footer { margin-top:20px; font-size:11px; color:#484f58; text-align:center; }
</style>
</head>
<body>
<h1>NIM Proxy Dashboard</h1>
<div class="stats">
  <div class="stat-card"><div class="num">${total}</div><div class="label">Requests</div></div>
  <div class="stat-card ok"><div class="num">${ok}</div><div class="label">Success</div></div>
  <div class="stat-card err"><div class="num">${err}</div><div class="label">Errors</div></div>
  <div class="stat-card"><div class="num">${avgMs}ms</div><div class="label">Avg Duration</div></div>
</div>
<div class="models">${topModels.map(([m, c]) => `<span class="model-tag"><span class="c">${c}</span> ${m}</span>`).join('')}</div>
<table>
<thead><tr><th>Time</th><th>Status</th><th>Model</th><th>Dur</th><th>Tokens</th><th>Endpoint</th></tr></thead>
<tbody>${log.slice(0, 100).map(e => {
  const statusClass = e.status < 300 ? 'status-2xx' : e.status < 500 ? 'status-4xx' : 'status-5xx';
  const tokStr = e.totalTokens ? `${e.promptTokens}→${e.completionTokens} (${e.totalTokens})` : '—';
  const retryTag = e.retry ? '<span class="retry">↻</span>' : '';
  const streamTag = e.stream ? '<span class="stream-badge">stream</span>' : '';
  return `<tr>
    <td class="time">${e.timeLocal || ''}</td>
    <td><span class="status ${statusClass}">${e.status}</span></td>
    <td class="model-name">${e.model}${retryTag}${streamTag}${e.error ? `<br><span class="error-msg">${e.error}</span>` : ''}</td>
    <td class="dur">${e.durationFmt}</td>
    <td class="tokens">${tokStr}</td>
    <td>${e.endpoint || 'chat'}</td>
  </tr>`;
}).join('')}</tbody>
</table>
<div class="footer">Showing last ${Math.min(total, 100)} of ${total} requests · NIM Proxy · ${new Date().toISOString()}</div>
</body>
</html>`);
});

// Catch-all for unsupported endpoints
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// Export app for Vercel serverless (or other serverless platforms)
module.exports = app;

// Only listen when run directly (not when imported as a serverless function)
if (require.main === module) {
  const server = app.listen(PORT, () => {
    // Preload benchmark data on startup
    shared.loadBenchmarkData();
    console.log('OpenAI to NVIDIA NIM Proxy running on port ' + PORT);
    console.log(`Dashboard: http://localhost:${PORT}/logs`);
    console.log(`Health:    http://localhost:${PORT}/health`);
    console.log(`Chat: http://localhost:${PORT}/v1/chat/completions`);
    console.log(`Embeddings: http://localhost:${PORT}/v1/embeddings`);
    console.log(`Images: http://localhost:${PORT}/v1/images/generations`);
    console.log(`Audio: http://localhost:${PORT}/v1/audio/transcriptions`);
    console.log(`Models: http://localhost:${PORT}/v1/models`);
    console.log(`Ranked: http://localhost:${PORT}/v1/models/ranked`);
  });

  // Graceful shutdown — close all connections on SIGTERM/SIGINT
  process.on('SIGTERM', () => {
    console.log('[PROXY] SIGTERM received — shutting down gracefully...');
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    console.log('[PROXY] SIGINT received — shutting down gracefully...');
    server.close(() => process.exit(0));
  });
}
