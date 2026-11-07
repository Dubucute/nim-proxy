# NVIDIA NIM Proxy 🚀

OpenAI-compatible API proxy for **all** NVIDIA NIM models — chat, embeddings, and image generation. Includes auto-ranked model benchmarks and VS Code integration.

Deploy on **alwaysdata**, **Vercel**, Docker, or run locally.

---

## 🧭 What changed in 2.0.0

The 1.x server kept growing in one 1000-line file until the seams started leaking. An audit
found eleven defects, each reproduced against the running server before being fixed — and
each now pinned by a test in [`test/regressions.test.js`](test/regressions.test.js):

| | Defect in 1.x | Fixed by |
|---|---|---|
| 1 | No auth and `cors()` wide open — anyone could spend your quota | `CORS_ORIGIN` allow-list, per-client `RATE_LIMIT_MAX`, request ids + client IP on every log entry, `X-Request-Id` attribution ([#Security posture](#-security-posture)) |
| 2 | Passthrough endpoints forwarded the caller's `apiKey` **inside the body to NVIDIA** | proxy-only fields stripped before forwarding |
| 3 | `top_k`, `min_p`, `repetition_penalty`, `n`, `seed` silently dropped | explicit NIM parameter allow-list, forwarded |
| 4 | `max_tokens: 0` quietly became 4096 | validated: `400 invalid_request_error` before an upstream call |
| 5 | `/logs` dashboard was **stored XSS** — the model name was interpolated raw | HTML escaping + CSP on the dashboard; model counts in a `Map` (no `__proto__` writes) |
| 6 | SSE `chunk.toString()` corrupted CJK/emoji split across TCP segments | `StringDecoder` across the whole relay |
| 7 | Model text containing `[DONE]` swallowed the terminator, clients hung | exact frame matching per the SSE spec |
| 8 | Upstream socket reset was reported as a clean `[DONE]` + 200 | SSE `error` event, logged `502 / upstream-error` |
| 9 | `ReferenceError: nimRequest is not defined` in the 429 path → HTML stack page | one retry pipeline + a real error handler; now a clean 429 |
| 10 | `nvext` telemetry leaked on the raw-write path | frames parsed, stripped and re-serialised uniformly |
| 11 | 6 concurrent `/v1/models` = 6 NVIDIA calls | single-flight refresh + stale-while-error |

Along the way: multipart uploads actually work, streaming `usage` reaches the request log,
`Retry-After` is honoured, rejected keys get disabled instead of retried forever, client
disconnects stop the upstream generation, error responses are JSON only, the body limit went
from 100mb to 10mb, keys are redacted in logs, and `npm test` went from `exit 1` to 65 tests.

---

## ✨ Features

- **Full OpenAI-compatible proxy** — drop-in replacement for any OpenAI client (`/v1/chat/completions`, legacy `/v1/completions`, `/v1/models`, `/v1/models/:id`)
- **All model types** — chat LLMs, embeddings, image/video generation and audio, including real `multipart/form-data` uploads (transcriptions relay the file bytes untouched)
- **SSE-safe streaming** — spec-compliant frame relay: multi-byte characters survive chunk boundaries, `nvext` telemetry is stripped, `[DONE]` is emitted exactly once, idle/stalled/truncated streams are reported as errors instead of masquerading as complete answers
- **Coding benchmark rankings** — `/v1/models/ranked` with real, tested scores, filterable by `type`, `tag`, `minScore`, `category`, `limit`
- **Model type detection** — auto-classifies each NVIDIA model as `chat`, `embedding`, `image`, `audio` or `safety`
- **Rotating API keys** — per-key cooldowns with exponential backoff and jitter, honouring NVIDIA's `Retry-After`; keys that get rejected are disabled instead of retried forever
- **Per-request custom API keys** — `Authorization: Bearer nvapi-...` (or `"apiKey"` in the body) uses that key for that request only; placeholder values like `proxy-no-auth-needed` correctly fall back to the pool
- **Observability** — request id on every response, in-memory request log with p50/p95/p99 latency and token totals, `/logs` dashboard, `/api/logs` JSON, `/health?deep=true`
- **Resilience** — bounded retries for retryable upstream failures, single-flight model fetch, stale-while-error catalogue, per-client rate limiting, graceful shutdown
- **Tested** — 65 tests (`npm test`) run the real proxy against a stubbed NVIDIA endpoint; no network, no keys, no flakiness
- **VS Code integration** — `refresh_config.py` generates `chatLanguageModels.json` with ranked models


---

## 🚀 Quick Deploy

### alwaysdata

1. **Create the site** — Web ▸ Sites ▸ Add a site · Type **Node.js** · Command `npm start` · Node.js **20 or 22** · root as the working directory.
2. **Set environment variables** — Web ▸ Sites ▸ your-site ▸ Environment:

| Variable | Value | Description |
|---|---|---|
| `NIM_API_KEY` | `nvapi-...` | NVIDIA API key (free at [build.nvidia.com](https://build.nvidia.com/)) |
| `NIM_API_KEY_2` | `nvapi-...` | (optional) second key for rate-limit rotation |
| `NIM_API_BASE` | `https://integrate.api.nvidia.com/v1` | (optional) upstream base URL |
| `CORS_ORIGIN` | `https://yourapp.example` | (optional) lock down browser access |

3. **Deploy** — Advanced ▸ Git deployment ▸ point at this repository, or upload everything
   except `node_modules/` over SFTP and run `npm install --omit=dev`.

Your proxy is then live at `https://your-username.alwaysdata.net` — check
`/health` first; it reports the key pool, the catalogue size and any warnings.

### Vercel

Import the repository. `vercel.json` routes everything to `api/index.js`, which re-uses the
same Express app. Set the environment variables in Project Settings ▸ Environment Variables.
Serverless caps response time, so for long streaming sessions prefer a persistent host.

### Docker

```bash
docker build -t nim-proxy .
docker run --rm -p 3000:3000 -e NIM_API_KEY=nvapi-... nim-proxy
```

---

## 🖥️ Local Development

```bash
npm install                 # Node 20+
cp .env.example .env        # then put a real key in .env (never commit it)
npm start                   # http://localhost:3000
npm run dev                 # debug logs + auto-reload
npm test                    # 65 tests, no network, no keys required
curl localhost:3000/health
open http://localhost:3000/logs
```


---

## 📡 API Endpoints

### All Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Service index |
| `GET` | `/health` | Status, key-pool state, limits, benchmark summary (`?deep=true` probes NVIDIA) |
| `GET` | `/v1/models` | List all models with types & benchmark data (`?type=`, `?limit=`) |
| `GET` | `/v1/models/:id` | Single model (what OpenAI SDKs call `models.retrieve`) |
| `GET` | `/v1/models/ranked` | Models sorted by coding benchmark score |
| `POST` | `/v1/chat/completions` | Chat completions (OpenAI-compatible, streaming + tools) |
| `POST` | `/v1/completions` | Legacy text completions / FIM, mapped onto chat |
| `POST` | `/v1/embeddings` | Vector embeddings |
| `POST` | `/v1/images/generations` | Image/video generation |
| `POST` | `/v1/images/edits` | Image edits (multipart upload relayed as-is) |
| `POST` | `/v1/audio/transcriptions` | Speech-to-text (multipart upload relayed as-is) |
| `POST` | `/v1/audio/translations` | Audio translation (multipart upload relayed as-is) |
| `POST` | `/v1/audio/speech` | Text-to-speech, streamed back |
| `GET` | `/logs` | Request dashboard (last 100; `?limit=`) — disable with `DASHBOARD_ENABLED=false` |
| `GET` | `/api/logs` | Same data as JSON, plus latency percentiles and key-pool status |


### `GET /health`

Pure state inspection — it does not call NVIDIA, so it is safe as a liveness probe:

```json
{
  "status": "ok",
  "service": "OpenAI-compatible proxy for NVIDIA NIM — chat, legacy completions, ...",
  "version": "2.0.0",
  "uptimeSec": 4212,
  "runtime": "node",
  "endpoints": { "chat": "/v1/chat/completions", "models": "/v1/models" },
  "keys": { "configured": 3, "cooling": 1, "disabled": 0, "totalUsed": 912, "totalRateLimited": 4, "soonestAvailableInMs": 21400 },
  "catalogue": { "models": 121, "ageMs": 612000 },
  "requests": { "buffered": 500, "total": 912 },
  "limits": { "body": "10mb", "rate": "120/60s", "upstreamTimeoutMs": 120000 },
  "warnings": ["CORS_ORIGIN is * — any origin may call this proxy"],
  "benchmarks": {
    "lastUpdated": "2026-07-14T04:15:43.900Z",
    "totalTested": 76,
    "working": 37,
    "failed": 39,
    "topModel": "meta/llama-3.2-1b-instruct",
    "topScore": 9285,
    "fastestModel": "nvidia/nemotron-mini-4b-instruct",
    "fastestTime": 1.64
  }
}
```

`status` is `degraded` (HTTP 503) when no `NIM_API_KEY` is configured, so a misconfigured deploy fails its own health check instead of looking healthy and 500-ing on the first request.


### `GET /v1/models`

Lists every model NVIDIA reports, each annotated with:
- **`type`** — model category: `chat`, `embedding`, `image`, `audio` or `safety`
- **`capabilities`** — which endpoints each model supports (`chat`, `embedding`, `image`, `audio`, `safety`, `toolCalling`, `vision`)
- **`benchmark`** — (if available) coding rank, combined score, speed and pass counts from `benchmark_data.json`

`total` always equals `data.length` — filters are applied before the count, so a filtered list reports the number of models you actually received.

#### Query params

| Param | Example | Description |
|---|---|---|
| `?type=embedding` | Filter by type | `chat`, `embedding`, `image`, `audio`, `safety` |
| `?limit=10` | First 10 | Capped at 5000 |

#### Response example

```json
{
  "object": "list",
  "total": 121,
  "data": [
    {
      "id": "meta/llama-3.1-8b-instruct",
      "type": "chat",
      "capabilities": {
        "chat": true,
        "embedding": false,
        "image": false,
        "audio": false,
        "toolCalling": true,
        "vision": false
      },
      "benchmark": {
        "rank": 4,
        "combinedScore": 9042,
        "speed": 2.17,
        "intelligence": 100,
        "codingTasks": { "fizzBuzz": true, "arrayChunk": true, ... }
      }
    }
  ]
}
```

### `POST /v1/chat/completions`

Full OpenAI-compatible chat completions. Supports:
- Streaming (SSE) and non-streaming, with streamed `usage` captured when you send `stream_options: {"include_usage": true}`
- Tool/function calling, `response_format`, vision (`image_url`) content parts
- NVIDIA sampling parameters: `temperature`, `top_p`, `top_k`, `min_p`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `n`, `stop`, `seed`, `logit_bias`, `logprobs`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`/`reasoning_effort`
- `max_completion_tokens` (mapped onto `max_tokens`) and a per-model-family default when you send neither
- API key rotation on rate limits, with `Retry-After` respected
- **Your own key** — `Authorization: Bearer nvapi-...` (or `"apiKey"` in the body) for that request only

Anything not on that list is dropped rather than forwarded, so a stray client field
cannot become an upstream 400 you never saw coming. Values validated locally
(`max_tokens`, `temperature`, `top_p`, `n`, penalties, `messages` shape) are rejected
with a `400 invalid_request_error` **before** an upstream call is spent.

**Request with custom key:**
```json
{
  "model": "meta/llama-3.1-8b-instruct",
  "messages": [{"role": "user", "content": "Hello!"}],
  "temperature": 0.7,
  "stream": false,
  "apiKey": "nvapi-your-own-key-here"
}
```

`apiKey` is never forwarded to NVIDIA. Placeholder values that mean "the proxy holds
the credentials" (`proxy-no-auth-needed`, `none`, `test`, …) fall back to the pool
instead of being sent as if they were real keys.

### `POST /v1/completions`

Legacy text completions, for autocomplete/FIM clients. `prompt` becomes a single
message, `max_tokens` defaults to 256 and `temperature` to 0.2, and the chat response
is mapped back to `text_completion` shape. Streaming works here too.


### `GET /v1/models/ranked`

Returns models sorted by **actual coding benchmark scores** (not just name). The rankings come from running real code generation tests — FizzBuzz, Array Chunk, Debounce, API Handler, and Promise.allSettled Polyfill.

#### Query params

| Param | Example | Description |
|---|---|---|
| `?limit=3` | Top 3 | Limit results |
| `?tag=fast` | Fast models | Filter by benchmark tag (`fast`, `smart`, `coding_expert`, `top_tier`, `best_overall`) |
| `?tag=vision` | Vision models | Filter by vision capability |
| `?minScore=8000` | Score ≥ 8000 | Minimum combined benchmark score |
| `?category=fastest` | Fastest category | `fastest`, `smartest`, `codingExperts` |
| `?type=chat` | Chat models | `chat`, `embedding`, `image` |

#### Response example

```json
{
  "object": "list",
  "total": 121,
  "benchmarkedCount": 37,
  "query": { "limit": 3, "minScore": null, "category": null, "tag": null },
  "data": [
    {
      "id": "meta/llama-3.2-1b-instruct",
      "type": "chat",
      "benchmark": {
        "rank": 1,
        "combinedScore": 9285,
        "speed": 1.78,
        "tags": ["coding_expert", "fast", "smart", "best_overall", "top_tier"]
      }
    },
    {
      "id": "microsoft/phi-4-multimodal-instruct",
      "benchmark": { "rank": 2, "combinedScore": 9097, ... }
    }
  ]
}
```

### Passthrough Endpoints (`/v1/embeddings`, `/v1/images/*`, `/v1/audio/*`)

These are relayed to NVIDIA's API with minimal transformation: proxy-only fields
(`apiKey`, `baseUrl`, …) are stripped, everything else is forwarded, and an embeddings
`input` given as a bare string is normalised to an array (what NVIDIA requires).

The file endpoints (`/v1/images/edits`, `/v1/audio/transcriptions`,
`/v1/audio/translations`) accept `multipart/form-data` and relay the upload byte-for-byte
with the caller's own boundary header, so real audio/image uploads work — previously
`express.json` swallowed the body and the handler sent `Content-Type: multipart/form-data`
with an empty JSON object. `/v1/audio/speech` streams the returned audio back.

**Embeddings example:**
```json
{
  "model": "nvidia/nv-embed-v1",
  "input": ["The sky is blue"]
}
```

**Image generation example:**
```json
{
  "model": "nvidia/cosmos-reason2-8b",
  "prompt": "A cat wearing a hat",
  "n": 1
}
```

---

## 🔄 VS Code Integration

### `refresh_config.py`

Generates VS Code's `chatLanguageModels.json` with all NVIDIA models, annotated with benchmark rankings and capabilities.

```bash
# Generate config (auto-detects VS Code path on Windows)
python refresh_config.py

# Or save to a custom location
python refresh_config.py my_custom_config.json
```

What it does:
1. Fetches the full model list from NVIDIA (~121 models)
2. Loads benchmark data from `benchmark_data.json`
3. Annotates each model with its rank, combined score, speed, intelligence, and coding score
4. Sorts models so ranked ones appear first
5. Sets tool-calling capability based on model family and size
6. Disables chat for embedding-only models

Output in VS Code's model picker:
```
  #1 meta/llama-3.2-1b-instruct [benchmarked]
  #2 microsoft/phi-4-multimodal-instruct [benchmarked]
  ...
  #122 some/other-model
```

---

## 🏆 Benchmark Data

### `benchmark_data.json`

Auto-generated by `benchmark_openai.py` — it tests each model against 5 real coding tasks:

| Task | Difficulty | What it tests |
|---|---|---|
| FizzBuzz | Easy | Correctness, modulo logic |
| Array Chunk | Medium | Array manipulation, slice/loop usage |
| Debounce Function | Hard | setTimeout/clearTimeout, closure patterns |
| API Route Handler | Medium | Express routing, pagination, JSON responses |
| Promise.allSettled | Expert | Promise chaining, error handling, status tracking |

Each model receives a **combined score** (0–10000) based on:
- **70%** — Coding score (checks passed / total checks)
- **30%** — Speed score (penalty curve: 1s = 100%, 30s = 0%)

The proxy reads this file at startup and re-reads it hourly, so refreshing the rankings
does not need a redeploy.

---

## 🧪 Benchmarking

```bash
export NIM_API_KEY=nvapi-...          # keys come from the environment only, never from code
python benchmark_openai.py            # every chat-capable model
python benchmark_openai.py --models 10
python benchmark_openai.py --models deepseek --dry-run
```

It measures tool calling, time-to-first-token (client and server side via NVIDIA's `nvext`
telemetry), tokens/sec, code quality, KV-cache hit rate, instruction following and router
queue depth. Raw artifacts land in `benchmark_artifacts/` (git-ignored); the ranking table
it prints is what `benchmark_data.json` records.

---

## 🧩 Architecture

```
                     ┌──────────────────────┐
                     │  Your app / VS Code  │
                     │  OpenAI-format calls │
                     └───────┬──────────────┘
                             │
     ┌───────────────────────▼───────────────────────┐
     │  src/app.js — middleware composition          │
     │  request ids · CORS allow-list · body limits  │
     │  per-client rate limit · error mapping        │
     ├───────────────────────────────────────────────┤
     │  src/routes/  health · models · chat ·        │
     │               passthrough · dashboard         │
     ├───────────────────────────────────────────────┤
     │  src/translate.js   OpenAI ⇄ NIM mapping      │
     │  src/sse.js         SSE frame relay           │
     │  src/upstream.js    pooling · timeouts · ...  │
     │  src/keys.js        rotation + cooldowns      │
     │  src/models.js      single-flight catalogue   │
     │  src/request-log.js metrics ring buffer       │
     └───────────────────────┬───────────────────────┘
                             │ Bearer nvapi-… (rotated)
                     ┌───────▼──────────────┐
                     │   NVIDIA NIM API     │
                     │ integrate.api.nvidia │
                     └──────────────────────┘
```

Only `src/config.js` reads `process.env`; only `src/upstream.js` calls NVIDIA. That
is what makes the whole proxy testable in one process, with no network.

### File Structure

| File | Purpose |
|---|---|
| `server.js` | Entry point: builds the app, listens when run directly, graceful shutdown |
| `api/index.js` | Vercel serverless handler (re-uses `server.js`) |
| `src/config.js` | Env parsing and validation — the only reader of `process.env` |
| `src/app.js` | Express composition (middleware + routes) |
| `src/middleware.js` | Request ids, security headers, CORS, rate limit, error handler |
| `src/translate.js` | OpenAI ⇄ NIM request/response translation and validation |
| `src/sse.js` | SSE frame relay: decode boundaries, `[DONE]`, `nvext`, usage, backpressure |
| `src/upstream.js` | Axios client, keep-alive pooling, timeouts, retries, key selection |
| `src/keys.js` | Key pool: rotation, cooldowns, `Retry-After`, disabling, safe status |
| `src/models.js` | Model catalogue with single-flight + stale-while-error |
| `src/request-log.js` | Bounded request log and latency/token metrics |
| `src/errors.js` | One error vocabulary, mapped to OpenAI-shaped JSON |
| `src/logger.js` | Levelled logging with key redaction |
| `src/routes/*.js` | `health`, `models`, `chat`, `passthrough`, `dashboard` |
| `shared.js` | Model capability / token-limit / benchmark helpers |
| `refresh_config.py` | Generates VS Code `chatLanguageModels.json` |
| `benchmark_openai.py` | Runs the coding benchmark against NVIDIA NIM |
| `benchmark_data.json` | Cached benchmark results |
| `test/` | Unit + end-to-end tests against a stubbed NVIDIA endpoint |
| `Dockerfile` | Container image (non-root, healthcheck) |
| `.github/workflows/ci.yml` | Tests, audit and secret scan on every push |

---

## 📦 Caching

| Data | Where | TTL | Notes |
|---|---|---|---|
| Model catalogue (NVIDIA) | process memory | 15 min (`MODELS_CACHE_TTL_MS`) | Concurrent callers **share one** upstream fetch; a failed refresh keeps serving the last good list for `MODELS_STALE_GRACE_MS` instead of returning an empty array |
| `/v1/models`, `/v1/models/ranked` | HTTP | `public, max-age=900, stale-while-revalidate=3600` | |
| Benchmark data (`benchmark_data.json`) | process memory | 1 hour | Re-read on expiry, so refreshed rankings need no redeploy |
| Request log | process memory | last 500 entries (`REQUEST_LOG_SIZE`) | Never persisted |
| Chat/embedding/image responses | — | none | Always proxied fresh |

---

## 🔑 API Keys

### Pool (rotating)

Keys come **only** from the environment — there is no built-in fallback key, and an
`npm run check`-style CI secret scan blocks the mistake at the door:

```
NIM_API_KEY=nvapi-key-1
NIM_API_KEY_2=nvapi-key-2
NIM_API_KEY_3=nvapi-key-3
```

Any variable matching `(NIM|NVIDIA)_API_KEY(_<n>)` is collected and de-duplicated.
Each request advances a cursor, so load spreads across the pool instead of hammering
one key.

### Rate limiting behaviour

On a 429 (or a `ResourceExhausted`/429-in-message variant) from NVIDIA:

1. that key gets a cooldown — `KEY_COOLDOWN_MS`, doubled per consecutive hit, capped at
   5 minutes, jittered, and extended to whatever `Retry-After` asks for
2. the request is retried on the next healthy key, up to `MAX_RETRIES` times
3. if genuinely nothing is available, the client gets a real **429** with
   `rate_limit_error` — plus the request id, so you can find it in `/logs`

Keys that NVIDIA rejects with 401/403 are **disabled** rather than retried forever, and
`/health` reports how many are cooling or disabled (counts only, never key material).

### Caller-supplied keys

A caller can bring its own key. Precedence and interpretation:

| What the caller sends | What happens |
|---|---|
| `Authorization: Bearer nvapi-…` | used for that request only; the pool is untouched |
| body `"apiKey": "nvapi-…"` | same (disable with `ALLOW_BODY_API_KEY=false`) |
| body `"apiKey": "proxy-no-auth-needed"` / `"none"` / any placeholder | ignored on purpose → pool |
| nothing | pool |
| a key NVIDIA rejects | that caller gets a 401; the pool is not blamed |

`apiKey` is stripped before anything is forwarded — in v1 it was relayed to NVIDIA
inside the request body on every passthrough endpoint.

---

## 🔒 Security posture

**This proxy is deliberately open: it has no authentication of its own.** Anyone who can
reach it can spend your NVIDIA quota. Design accordingly:

- keep it on a private network, a host you firewall, or a platform with auth in front
- if it must be public, put a real gateway in front of it; `RATE_LIMIT_MAX` is a
  memory-local courtesy, not a boundary (on serverless each instance has its own counter)
- `CORS_ORIGIN` defaults to `*`; set an allow-list so arbitrary websites cannot drive it
- `/logs` and `/api/logs` expose request metadata (models, timings, client IPs). They are
  HTML-escaped and CSP-restricted, and can be switched off with `DASHBOARD_ENABLED=false`
  and `EXPOSE_INTERNAL_ENDPOINTS=false`
- bodies are capped (`BODY_LIMIT`, default 10mb) and non-JSON content types are refused
- error responses are JSON only — no stack traces, no file paths
- the logger redacts key material, so an accidental `console.log` cannot leak one

---

## ⚙️ Configuration

Every knob lives in `src/config.js` and is read once at startup; invalid values throw
immediately rather than degrading quietly. See [`.env.example`](.env.example) for the
annotated list.

| Variable | Default | What it does |
|---|---|---|
| `NIM_API_KEY`(+`_2`…`_n`) | — | Upstream keys, rotated as a pool |
| `NIM_API_BASE` | `https://integrate.api.nvidia.com/v1` | Upstream base URL |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `LOG_LEVEL` / `LOG_JSON` | `info` / off | Verbosity; JSON lines for log shippers |
| `BODY_LIMIT` | `10mb` | Max request body (JSON and multipart) |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `120` / `60000` | Per-client window; `0` disables |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream response timeout |
| `STREAM_IDLE_TIMEOUT_MS` | `120000` | Abort a stream producing no bytes for this long |
| `MAX_RETRIES` | `2` | Retryable attempts per request |
| `KEY_COOLDOWN_MS` | `30000` | Base rate-limit cooldown per key |
| `CORS_ORIGIN` | `*` | `*` or comma-separated allow-list |
| `ALLOW_BODY_API_KEY` | `true` | Accept `apiKey` in the JSON body |
| `DASHBOARD_ENABLED` | `true` | Serve `/logs` |
| `EXPOSE_INTERNAL_ENDPOINTS` | `true` | Serve `/api/logs`, `/health?deep` |
| `MODELS_CACHE_TTL_MS` / `MODELS_STALE_GRACE_MS` | `900000` / `86400000` | Catalogue freshness and stale ceiling |
| `TRUST_PROXY` | off | Honour `X-Forwarded-For` (auto-on under Vercel) |
| `UPSTREAM_MAX_SOCKETS` | `64` | Keep-alive pool size |

---

## 🧪 Tests and CI

```bash
npm test              # 65 tests, ~4s
npm run test:ci       # same, spec reporter
```

Everything runs in-process against `test/helpers/stub-upstream.js` — a fake
`integrate.api.nvidia.com` that can answer 429s, kill a socket mid-stream, split a
multi-byte character across TCP segments, or hold a stream open, so the failure paths are
actually exercised instead of hoped for. `test/regressions.test.js` names the eleven
defects found in v1.0.0 and pins each one.

`.github/workflows/ci.yml` runs the suite on Node 20/22/24, audits dependencies, and fails
the build if a `nvapi-` secret appears in the tree.

---

## 🐳 Running it

```bash
npm start                      # local
docker build -t nim-proxy .
docker run --rm -p 3000:3000 -e NIM_API_KEY=nvapi-... nim-proxy
```

Docker runs as a non-root user with an HTTP healthcheck against `/health`. On
alwaysdata, keep `npm start` and set the environment variables in the site config.
On Vercel the app is served through `api/index.js`; note that serverless functions cap
response time, so long streams are better on a persistent host.

### Operations

- **`GET /health`** — key pool state, catalogue age, limits, warnings. `?deep=true` probes NVIDIA.
- **`GET /logs`** — last 100 requests with status, latency, tokens, which key served them, retries and the stream outcome (`done`, `truncated`, `stalled`, `aborted`, `upstream-error`).
- **`GET /api/logs`** — the same as JSON, plus p50/p95/p99 and error rate; wire this to a scraper if you want history.
- Shutdown is graceful: `SIGTERM` drains in-flight requests for up to 10s, then closes the socket pool.

**Status codes you should expect** (the whole point of the rewrite):

| Situation | v1.0.0 | Now |
|---|---|---|
| Rate limited on every key | `500` + HTML stack trace | `429 rate_limit_error` |
| NVIDIA 401 on your pool key | `502`, key retried forever | pool key disabled, `502 upstream_auth_error`, other keys keep working |
| Upstream stream dies mid-answer | `200` + fake `[DONE]` | SSE `error` event + `502` in the log |
| Model text contains `[DONE]` | terminator swallowed, client hangs | forwarded as content, one terminator at the end |
| Body not JSON | `400` from body-parser internals | `415` / `400` with a clear message |
| `max_tokens: 0` | silently became 4096 | `400 invalid_request_error` |


---

## 📋 Usage Examples

### Client Setup

```bash
# Your proxy URL (replace with your deployed URL)
PROXY="https://dubu.alwaysdata.net"
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://dubu.alwaysdata.net",
    api_key="any-value"  # proxy doesn't require auth
)
```

---

### 🏥 Health Check

```bash
curl $PROXY/health | python -m json.tool
```

```python
import requests
print(requests.get(f"{client.base_url}/health").json())
```

---

### 📋 List Models

**All models:**
```bash
curl $PROXY/v1/models
```

**Filter by type:**
```bash
# Only chat models
curl $PROXY/v1/models?type=chat

# Only embedding models
curl $PROXY/v1/models?type=embedding

# Only image/video models
curl $PROXY/v1/models?type=image
```

---

### 🏆 Ranked Models (by benchmark score)

**Top 5 overall:**
```bash
curl $PROXY/v1/models/ranked?limit=5
```

**Fastest models:**
```bash
curl "$PROXY/v1/models/ranked?tag=fast&limit=3"
```

**Smartest models (score ≥ 8500):**
```bash
curl "$PROXY/v1/models/ranked?minScore=8500"
```

**Vision-capable, ranked by score:**
```bash
curl "$PROXY/v1/models/ranked?tag=vision&limit=5"
```

**By category (fastest / smartest / codingExperts):**
```bash
curl "$PROXY/v1/models/ranked?category=fastest"
```

**Top-ranked embedding models:**
```bash
# Note: embedding models don't have coding benchmark data yet
curl "$PROXY/v1/models/ranked?type=embedding"
```

---

### 💬 Chat Completions

**Basic text chat:**
```bash
curl $PROXY/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Hello!"}],
    "temperature": 0.7
  }'
```

```python
response = client.chat.completions.create(
    model="meta/llama-3.1-8b-instruct",
    messages=[{"role": "user", "content": "Hello!"}],
    temperature=0.7
)
print(response.choices[0].message.content)
```

**Streaming (server-sent events):**
```bash
curl -N $PROXY/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistralai/mistral-small-4-119b-2603",
    "messages": [{"role": "user", "content": "Write a poem about AI"}],
    "stream": true
  }'
```

```python
stream = client.chat.completions.create(
    model="mistralai/mistral-small-4-119b-2603",
    messages=[{"role": "user", "content": "Write a poem about AI"}],
    stream=True
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

**Vision — image-to-text (use a vision-capable model):**
```bash
curl $PROXY/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "microsoft/phi-4-multimodal-instruct",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What is in this image?"},
          {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png"}}
        ]
      }
    ],
    "max_tokens": 200
  }'
```

```python
import requests

response = client.chat.completions.create(
    model="microsoft/phi-4-multimodal-instruct",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "What is in this image?"},
                {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png"}}
            ]
        }
    ],
    max_tokens=200
)
print(response.choices[0].message.content)
```

**Multi-turn conversation:**
```bash
curl $PROXY/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is the capital of France?"},
      {"role": "assistant", "content": "Paris."},
      {"role": "user", "content": "What is its population?"}
    ]
  }'
```

**Tool / function calling:**
```bash
curl $PROXY/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "What is the weather in London?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current temperature for a city",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "City name"}
          },
          "required": ["city"]
        }
      }
    }]
  }'
```

---

### 🔢 Embeddings

**Single text:**
```bash
curl $PROXY/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nv-embed-v1",
    "input": "The sky is blue"
  }'
```

**Batch of texts:**
```bash
curl $PROXY/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/nv-embed-v1",
    "input": ["Hello world", "How are you?", "Goodbye"]
  }'
```

```python
response = client.embeddings.create(
    model="nvidia/nv-embed-v1",
    input=["Hello world", "How are you?", "Goodbye"]
)
for item in response.data:
    print(f"Index {item.index}: vector of {len(item.embedding)} dimensions")
```

**Find all available embedding models:**
```bash
curl "$PROXY/v1/models?type=embedding" | python -m json.tool
```

---

### 🎨 Image Generation

```bash
curl $PROXY/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/cosmos-reason2-8b",
    "prompt": "A serene mountain landscape at sunset with a lake reflection",
    "n": 1
  }'
```

```python
response = client.images.generate(
    model="nvidia/cosmos-reason2-8b",
    prompt="A serene mountain landscape at sunset with a lake reflection",
    n=1
)
print(response.data[0].url)
```

**Available image models:**
```bash
curl "$PROXY/v1/models?type=image"
```

---

### 🔍 Quick reference

| Endpoint | What it does | Best for |
|---|---|---|
| `GET /v1/models` | List all models | Finding model IDs |
| `GET /v1/models/:id` | One model | SDK `models.retrieve()` calls |
| `GET /v1/models/ranked` | Models sorted by benchmark score | Choosing the best model |
| `POST /v1/chat/completions` | Text generation, vision, tools | Chat, coding, analysis |
| `POST /v1/completions` | Legacy/FIM text completion | Autocomplete-style clients |
| `POST /v1/embeddings` | Vector embeddings | Search, RAG, clustering |
| `POST /v1/images/generations` | Image/video generation | Visual content creation |
| `POST /v1/audio/transcriptions` | Speech-to-text (multipart) | Whisper-like workflows |
| `GET /health` | Status, key pool, limits, benchmarks | Monitoring |
| `GET /logs` | Live request dashboard | Debugging what actually happened |

---

### From VS Code

Install [Continue](https://continue.dev/) or Cline and set:
```json
{
  "apiBase": "https://your-proxy.example",
  "apiKey": "any-value-works"
}
```

Or generate the full model list with `python refresh_config.py` (see
[VS Code Integration](#-vs-code-integration)).

## 📄 License

MIT — use freely, modify, and share.

