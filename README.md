# NVIDIA NIM Proxy 🚀

OpenAI-compatible API proxy for **all** NVIDIA NIM models — chat, embeddings, and image generation. Includes auto-ranked model benchmarks and VS Code integration.

Deploy on **alwaysdata** for free, or run locally.

---

## ✨ Features

- **Full OpenAI-compatible proxy** — drop-in replacement for any OpenAI client
- **All model types** — chat LLMs, embeddings, and image generation
- **Coding benchmark rankings** — `/v1/models/ranked` with real, tested scores for 37+ models
- **Model type detection** — auto-classifies each of the ~121 NVIDIA models as `chat`, `embedding`, `image`, `audio`, or `safety`
- **Rotating API keys** — if one key hits a rate limit, automatically falls through to the next
- **Per-request custom API keys** — pass `"apiKey": "nvapi-..."` in any request body to override the pool
- **Streaming support** — SSE streaming for chat completions
- **VS Code integration** — `refresh_config.py` generates `chatLanguageModels.json` with ranked models

---

## 🚀 Quick Deploy to alwaysdata

### 1. Push to Git

```bash
git init
git add .
git commit -m "Initial commit"
```

### 2. Create an alwaysdata site

- Go to **Web > Sites > Add a site**
- **Type**: Node.js
- **Command**: `npm start`
- **Node.js version**: 18 or 20
- **Working directory**: `www` (or root)

### 3. Set environment variables

In **Web > Sites > your-site > Environment**, add:

| Variable | Value | Description |
|---|---|---|
| `NIM_API_KEY` | `nvapi-...` | NVIDIA API key (get free at [build.nvidia.com](https://build.nvidia.com/)) |
| `NIM_API_KEY_2` | `nvapi-...` | (optional) Backup key for rate-limit rotation |
| `NIM_API_BASE` | `https://integrate.api.nvidia.com/v1` | NVIDIA NIM API base URL |
| `PORT` | `3000` | (optional) Override port |

### 4. Deploy

Via **Git** (simplest):
- In alwaysdata admin, go to **Advanced > Git deployment**
- Point it to your repository

Via **SFTP**:
- Upload all files (except `node_modules/`) to the `www` directory
- SSH in and run `npm install`

### 5. Done!

Your proxy is live at `https://your-username.alwaysdata.net`

---

## 🖥️ Local Development

```bash
# Install dependencies
npm install

# Copy and edit env file
echo "NIM_API_KEY=nvapi-your-key-here" > .env

# Start
npm start
```

---

## 📡 API Endpoints

### All Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check + benchmark summary |
| `GET` | `/v1/models` | List all models with types & benchmark data |
| `POST` | `/v1/chat/completions` | Chat completions (OpenAI-compatible) |
| `GET` | `/v1/models/ranked` | Models sorted by coding benchmark score |
| `POST` | `/v1/embeddings` | Vector embeddings |
| `POST` | `/v1/images/generations` | Image/video generation |


### `GET /health`

Returns server status, available endpoints, and benchmark summary:

```json
{
  "status": "ok",
  "service": "OpenAI to NVIDIA NIM Proxy",
  "endpoints": {
    "chat": "/v1/chat/completions",
    "embeddings": "/v1/embeddings",
    "images": "/v1/images/generations",
    "models": "/v1/models",
    "ranked": "/v1/models/ranked"
  },
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

### `GET /v1/models`

Lists all ~121 models from NVIDIA, each with:
- **`type`** — model category: `chat`, `embedding`, `image`, or `safety`
- **`capabilities`** — which endpoints each model supports
- **`benchmark`** — (if available) coding rank, score, speed, intelligence from our test suite

#### Query params

| Param | Example | Description |
|---|---|---|
| `?type=embedding` | Filter by type | `chat`, `embedding`, `image` |

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
- Streaming (SSE) and non-streaming
- Tool/function calling
- `max_tokens` auto-set per model family
- API key rotation on rate limits
- **Custom API key** — add `"apiKey": "nvapi-..."` to override the pool for that request

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

These are proxied directly to NVIDIA's API with no transformation. Send the same request body you'd send to `https://integrate.api.nvidia.com/v1/...`. Custom API keys work here too — add `"apiKey": "nvapi-..."` in the body.

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

Auto-generated by `benchmark.js` — tests each model against 5 real coding tasks:

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

### `coding_test.js`

Quick test for just the **top 5 models** (faster, good for spot-checking):

```bash
node coding_test.js
```

### `benchmark.js`

Full benchmark for all **76 known chat-capable models** (takes a while, 37 models usually pass):

```bash
node benchmark.js
```

---

## 🧩 Architecture

```
                    ┌─────────────────────┐
                    │   Your App / VS Code │
                    └──────┬──────────────┘
                           │ OpenAI-format requests
                    ┌──────▼──────────────┐
                    │   server.js (Proxy)  │
                    │                     │
                    │  ┌───────────────┐  │
                    │  │  shared.js     │  │
                    │  │ • benchmark    │  │
                    │  │ • vision       │  │
                    │  │ • token limits │  │
                    │  │ • model type   │  │
                    │  │ • ranked sort  │  │
                    │  └───────────────┘  │
                    └──────┬──────────────┘
                           │ NVIDIA-format requests
                    ┌──────▼──────────────┐
                    │   NVIDIA NIM API     │
                    │ integrate.api.nvidia │
                    └─────────────────────┘
```

### File Structure

| File | Purpose |
|---|---|
| `server.js` | Express proxy server — all endpoints |
| `shared.js` | Shared utilities (benchmark, vision, tokens, model types) |
| `refresh_config.py` | Generates VS Code `chatLanguageModels.json` |
| `benchmark.js` | Full coding benchmark (76 models) |
| `coding_test.js` | Quick spot-check benchmark (top 5 models) |
| `benchmark_data.json` | Cached benchmark results |
| `test_ranked.js` | Integration test for `/v1/models/ranked` |

---

## 📦 Caching

Responses are cached to reduce latency:

| Data | Cache TTL | Cache-Control |
|---|---|---|
| Model list (from NVIDIA) | 15 minutes | `public, max-age=900, stale-while-revalidate=3600` |
| Benchmark data (from file) | 1 hour | — |
| Chat completions | None | — |

---

## 🔑 API Keys

### Default Pool (rotating)

The proxy maintains a rotating pool of API keys. Set via environment variables:
```
NIM_API_KEY=nvapi-key-1
NIM_API_KEY_2=nvapi-key-2
NIM_API_KEY_3=nvapi-key-3
```
If no env vars are set, two hardcoded fallback keys are used.

### Rate Limiting

When a 429 (rate limit) or 503 (ResourceExhausted) error occurs:
1. The proxy **rotates** to the next API key in the pool
2. **Retries** the request once with the new key
3. If all keys are exhausted, returns a 429 error

### Custom Key Per Request

Override the pool **for a single request** by including `apiKey` in the request body:

```bash
curl https://dubu.alwaysdata.net/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Hello!"}],
    "apiKey": "nvapi-your-own-key-here"
  }'
```

This works on all endpoints: `/v1/chat/completions`, `/v1/embeddings`, `/v1/images/*`, `/v1/audio/*`. Set `"apiKey": "none"` or omit it to use the default rotating pool.

**Priority:** request body `apiKey` → env vars → hardcoded fallback

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
| `GET /v1/models/ranked` | Models sorted by benchmark score | Choosing the best model |
| `POST /v1/chat/completions` | Text generation, vision, tools | Chat, coding, analysis |
| `POST /v1/embeddings` | Vector embeddings | Search, RAG, clustering |
| `POST /v1/images/generations` | Image/video generation | Visual content creation |
| `GET /health` | Server status + benchmark summary | Monitoring |

---

### From VS Code

Install [Continue](https://continue.dev/) or Cline and set:
```json
{
  "apiBase": "https://dubu.alwaysdata.net",
  "apiKey": "any-value-works"
}
```

## 📄 License

MIT — use freely, modify, and share.
