// shared.js — Shared utilities for NVIDIA NIM Proxy
// Benchmark data loading, model capabilities, token limits, ranking

const fs = require('fs');
const path = require('path');

// Path to benchmark data (same directory as this script)
const BENCHMARK_PATH = path.join(__dirname, 'benchmark_data.json');

// Vision detection — known vision model keywords
const VISION_KEYWORDS = ['vision', 'vlm', 'vl', 'multimodal', 'fuyu', 'kosmos', 'neva', 'vila', 'nvclip', 'deplot'];

// Benchmark data cache
let benchmarkCache = { data: null, lastFetched: 0 };
const BENCHMARK_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Load benchmark data from benchmark_data.json
 * Cached with 1-hour TTL and lazy refresh.
 * Returns { raw: <full JSON>, lookup: { model_id -> ranking_entry } }
 */
function loadBenchmarkData() {
  const now = Date.now();
  if (benchmarkCache.data && now - benchmarkCache.lastFetched < BENCHMARK_CACHE_TTL) {
    return benchmarkCache.data;
  }
  try {
    if (fs.existsSync(BENCHMARK_PATH)) {
      const raw = fs.readFileSync(BENCHMARK_PATH, 'utf-8');
      const data = JSON.parse(raw);
      // Build lookup: model_id -> benchmark entry
      const lookup = {};
      for (const entry of data.rankings || []) {
        lookup[entry.model] = entry;
      }
      benchmarkCache.data = { raw: data, lookup };
      benchmarkCache.lastFetched = now;
      return benchmarkCache.data;
    }
  } catch (e) {
    console.error('[SHARED] Failed to load benchmark data:', e.message);
  }
  return { raw: null, lookup: {} };
}

/**
 * Check if a model ID has vision/multimodal capabilities
 */
function getVisionCapability(modelId) {
  const low = modelId.toLowerCase();
  return VISION_KEYWORDS.some(kw => low.includes(kw));
}

/**
 * Classify a model by its endpoint type based on the model ID.
 * Returns: 'chat' | 'embedding' | 'image' | 'audio' | 'safety' | 'other'
 */
function getModelType(modelId) {
  const low = modelId.toLowerCase();

  // Embedding/retrieval models
  if (/embed|bge|nvclip|nemoretriever/i.test(low)) return 'embedding';

  // Image/video generation models
  // Note: stable-diffusion, flux, sdxl, trellis exist on build.nvidia.com but not on integrate.api.nvidia.com
  if (/stable-diffusion|sdxl|edgen|cosmos|flux|sana|pixart|imagen|dall-e|würstchen|deepfloyd|diffusiongemma|trellis|stable-video/i.test(low)) return 'image';

  // Audio/speech models (none exist on integrate.api.nvidia.com currently)
  if (/(?:^|[\/-])(?:parakeet|canary|whisper|tts|asr|speech)(?:[\/-]|$)/i.test(low)) return 'audio';

  // Safety/guard models
  if (/guard|safety|content-safety/i.test(low)) return 'safety';

  // Default: chat-capable LLM / VLM
  return 'chat';
}

/**
 * Per-model max_tokens defaults based on NVIDIA NIM API limits
 */
function getDefaultMaxTokens(model) {
  const low = model.toLowerCase();
  if (/deepseek/i.test(low)) return 16384;
  if (/nemotron.*mini/i.test(low)) return 4096;
  if (/nemotron/i.test(low)) return 16384;
  if (/phi-4/i.test(low)) return 16384;
  if (/mistral.*large|ministral|mistral.*medium|gemma-?[34]/i.test(low)) return 8192;
  if (/llama|qwen|dracarys|mixtral|mistral.*7b|mistral.*8x|codegemma|gemma.*2b|nano.*9b/i.test(low)) return 4096;
  return 4096;
}

/**
 * Sort an array of model entries by benchmark rank.
 * Ranked models come first (sorted by rank ascending, combinedScore descending),
 * then unranked models (instruct first, then alphabetical).
 */
function getRankedSort(entries, benchmarkLookup) {
  return entries.sort((a, b) => {
    const benchA = benchmarkLookup[a.id];
    const benchB = benchmarkLookup[b.id];
    const hasA = !!benchA;
    const hasB = !!benchB;

    // Benchmark-ranked models come first
    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;

    if (hasA && hasB) {
      // By rank ascending, or combinedScore descending if same rank
      if (benchA.rank !== benchB.rank) return benchA.rank - benchB.rank;
      return (benchB.combinedScore || 0) - (benchA.combinedScore || 0);
    }

    // Unranked models: instruct first, then alphabetical
    const aInstruct = a.id.toLowerCase().includes('instruct') ? 0 : 1;
    const bInstruct = b.id.toLowerCase().includes('instruct') ? 0 : 1;
    if (aInstruct !== bInstruct) return aInstruct - bInstruct;
    return a.id.toLowerCase().localeCompare(b.id.toLowerCase());
  });
}

/**
 * Build a benchmark summary object for display in health/status endpoints
 */
function getBenchmarkSummary(data) {
  if (!data || !data.raw) return null;
  const r = data.raw;
  const rankings = r.rankings || [];

  // Find fastest model (lowest responseTimeSec among ranked)
  let fastest = null;
  let fastestTime = Infinity;
  for (const m of rankings) {
    const time = m.speed?.responseTimeSec;
    if (time && time < fastestTime) {
      fastestTime = time;
      fastest = m.model;
    }
  }

  return {
    lastUpdated: r.lastUpdated,
    totalTested: r.totalModelsTested || 0,
    working: r.modelsWorking || 0,
    failed: r.modelsFailed || 0,
    topModel: rankings[0]?.model || null,
    topScore: rankings[0]?.combinedScore || null,
    fastestModel: fastest,
    fastestTime: fastestTime < Infinity ? fastestTime : null
  };
}

module.exports = {
  loadBenchmarkData,
  getVisionCapability,
  getDefaultMaxTokens,
  getRankedSort,
  getBenchmarkSummary,
  getModelType,
  VISION_KEYWORDS
};
