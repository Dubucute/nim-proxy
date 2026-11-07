"""Refresh VS Code chatLanguageModels.json from NVIDIA NIM API.
Includes ALL models from NVIDIA with benchmark annotations."""
import sys
import json
import urllib.request
import pathlib
import re
import os

PROXY_URL = os.environ.get('NIM_PROXY_URL', 'https://dubu.alwaysdata.net')

# NVIDIA API base (fetch full model list from source)
NVIDIA_API_BASE = os.environ.get('NIM_API_BASE', 'https://integrate.api.nvidia.com/v1')

# API keys come from the environment only. They used to fall back to keys
# hardcoded in this file, which meant real credentials sat in a public repo.
def _get_nvidia_api_keys():
    keys = []
    for name, value in os.environ.items():
        if name.startswith(('NIM_API_KEY', 'NVIDIA_API_KEY')) and value and value.strip():
            keys.append(value.strip())
    return sorted(set(keys))


_NVIDIA_API_KEYS = _get_nvidia_api_keys()


def _get_nvidia_api_key():
    if not _NVIDIA_API_KEYS:
        sys.exit(
            'NIM_API_KEY is not set.\n'
            'Generate a free key at https://build.nvidia.com/ and either\n'
            '  export NIM_API_KEY=nvapi-...        (then re-run this script), or\n'
            '  put it in a .env file next to server.js and run this through the proxy.'
        )
    return _NVIDIA_API_KEYS[0]

# Default output path: Windows VS Code config path
_DEFAULT_WIN_PATH = pathlib.Path('C:/Users/J Marlo/AppData/Roaming/Code/User/chatLanguageModels.json')
# Fallback: save locally if Windows path doesn't exist
_LOCAL_FALLBACK = pathlib.Path('chatLanguageModels.json')

# Determine output path:
# 1. CLI argument: python refresh_config.py /path/to/output.json
# 2. Windows path if it exists
# 3. Local fallback
if len(sys.argv) > 1:
    CONFIG_PATH = pathlib.Path(sys.argv[1])
elif _DEFAULT_WIN_PATH.exists():
    CONFIG_PATH = _DEFAULT_WIN_PATH
else:
    CONFIG_PATH = _LOCAL_FALLBACK

# Path to benchmark data (same directory as this script)
BENCHMARK_PATH = pathlib.Path(__file__).parent / 'benchmark_data.json'

# ============================================================
# LOAD BENCHMARK DATA (rankings from our tests)
# ============================================================
def load_benchmark_data():
    """Load benchmark_data.json if it exists."""
    try:
        if BENCHMARK_PATH.exists():
            with open(BENCHMARK_PATH, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # Build lookup: model_id -> benchmark entry
            lookup = {}
            for entry in data.get('rankings', []):
                lookup[entry['model']] = entry
            return lookup, data
    except Exception as e:
        print(f'  [WARN] Could not load benchmark data: {e}')
    return {}, {}

# ============================================================
# MODEL CAPABILITY ANNOTATIONS
# ============================================================
VISION_KEYWORDS = ['vision', 'vlm', 'vl', 'multimodal', 'fuyu', 'kosmos', 'neva', 'vila', 'nvclip', 'deplot']

def get_tool_capability(model_id, failed_set=None):
    """Return True if model supports tool/function calling.
    Disabled for: failed benchmark models, embedding/retrieval models,
    safety/guard models.
    """
    low = model_id.lower()

    # Failed benchmark tests — no reliable tool calling
    if failed_set and model_id in failed_set:
        return False
    # Safety/guard models — no chat tool calling
    if any(x in low for x in ('guard', 'safety', 'content-safety')):
        return False
    # Embedding/retrieval models — no chat tool calling
    if any(x in low for x in ('embed', 'bge', 'nvclip', 'nemoretriever')):
        return False
    return True

def is_embedding_model(model_id):
    """Return True if model is embedding-only (no chat)."""
    low = model_id.lower()
    return any(x in low for x in ('embed', 'bge', 'nvclip', 'nemoretriever'))


def get_vision_capability(model_id):
    low = model_id.lower()
    return any(kw in low for kw in VISION_KEYWORDS)

def shorten_name(model_id):
    """Convert a full model ID to a short display name.
    e.g. 'mistralai/mistral-large-3-675b-instruct-2512' -> 'Mistral Large 3 675B'
    """
    # Strip org prefix (everything before and including first '/')
    name = model_id.split('/', 1)[-1] if '/' in model_id else model_id

    # Remove common suffixes (order matters - more specific first)
    suffixes = [
        '-instruct-2512', '-instruct-2603', '-instruct-v0.1', '-instruct-v0.3',
        '-vision-instruct', '-128k-instruct', '-instruct',
        '-it', '-v2-vl', '-v1', '-v2',
        '-a55b', '-a17b', '-a10b', '-a12b', '-a3b', '-a800m', '-128e',
    ]
    for suffix in suffixes:
        if name.lower().endswith(suffix):
            name = name[:-len(suffix)]
            break

    # Capitalize: split on '-', capitalize each part, join with spaces
    # But keep version numbers like 3.1, 3.5, etc.
    parts = name.split('-')
    cleaned = []
    for p in parts:
        if not p:
            continue
        # Keep numbers as-is (but uppercase 'b' suffix)
        if p[-1].lower() == 'b' and p[:-1].replace('.', '').isdigit():
            # e.g. '8b' -> '8B', '10.7b' -> '10.7B'
            cleaned.append(p[:-1] + 'B')
        elif p.replace('.', '').isdigit():
            # Keep version numbers like 3.1 as-is
            cleaned.append(p)
        elif p.lower() == 'vlm':
            cleaned.append('VLM')
        elif p.lower() == 'moe':
            cleaned.append('MoE')
        else:
            # Capitalize first letter
            cleaned.append(p[0].upper() + p[1:] if p else p)

    return ' '.join(cleaned)


def get_model_label(bench_entry):
    """Return a descriptor label based on benchmark performance.
    e.g. 'Fast & Smart', 'Slow', 'Medium', 'Smart'
    """
    if not bench_entry:
        return ''
    speed = bench_entry.get('speed', {})
    coding = bench_entry.get('coding', {})
    speed_rank = (speed.get('rank') or '').lower() if speed else ''
    coding_pct = coding.get('percentage', 0) if coding else 0

    # Map speed rank to display label
    speed_label = ''
    if speed_rank == 'fast':
        speed_label = 'Fast'
    elif speed_rank == 'medium':
        speed_label = 'Medium'
    elif speed_rank in ('slow', 'very_slow'):
        speed_label = 'Slow'

    is_smart = coding_pct >= 80

    if speed_label and is_smart:
        return f'{speed_label} & Smart'
    if speed_label:
        return speed_label
    if is_smart:
        return 'Smart'
    return ''


def fetch_models():
    """Fetch ALL models from NVIDIA's API (121+ models)."""
    url = f'{NVIDIA_API_BASE}/models'
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {_get_nvidia_api_key()}',
        'Content-Type': 'application/json'
    })
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
    return [m['id'] for m in data['data']]

def get_token_limits(model_id):
    """Return (max_input_tokens, max_output_tokens) based on model family."""
    low = model_id.lower()
    param_match = re.search(r'(\d+)b', low)
    params_b = int(param_match.group(1)) if param_match else 0

    if any(x in low for x in ('vision', 'vlm', 'multimodal')):
        return (128000, 4096)
    if any(x in low for x in ('thinking', 'reasoning')):
        return (128000, 16384)
    if 'deepseek' in low:
        if 'coder' in low:
            return (131072, 8192)
        return (128000, 16384)
    if 'qwen' in low or 'qwq' in low:
        if '397b' in low or '397' in low:
            return (262144, 16384)
        if '122b' in low or '122' in low:
            return (131072, 16384)
        return (131072, 16384)
    if 'mistral' in low or 'mixtral' in low or 'ministral' in low or 'codestral' in low:
        if 'large' in low or 'small' in low or 'medium' in low:
            return (128000, 8192)
        if 'ministral' in low:
            return (128000, 8192)
        if 'codestral' in low:
            return (32768, 8192)
        if 'nemotron' in low or 'nemo' in low:
            if '12b' in low:
                return (128000, 4096)
            return (128000, 8192)
        if '8x7b' in low:
            return (32768, 4096)
        if '8x22b' in low:
            return (65536, 4096)
        if 'mistral-7b' in low:
            return (8192, 4096)
        return (128000, 8192)
    if 'llama' in low:
        if 'llama-4' in low or 'llama4' in low:
            return (128000, 4096)
        if 'llama-3.2' in low or 'llama3.2' in low:
            return (128000, 4096)
        if 'llama-3.3' in low or 'llama3.3' in low:
            return (128000, 4096)
        if 'llama-3.1' in low or 'llama3.1' in low:
            if 'ultra' in low or '253b' in low:
                return (128000, 16384)
            return (128000, 4096)
        if 'llama2' in low or 'codellama' in low:
            return (4096, 2048)
        return (128000, 4096)
    if 'nemotron' in low and 'llama' not in low:
        if 'ultra-550b' in low or 'ultra' in low:
            return (128000, 16384)
        if 'super-120b' in low or 'super-49b' in low:
            return (128000, 16384)
        if 'nano-30b' in low or 'nano' in low:
            return (128000, 4096)
        if 'mini-4b' in low or 'mini' in low:
            return (4096, 4096)
        if '4-340b' in low:
            return (4096, 1024)
        return (128000, 4096)
    if 'phi-' in low or 'phi-4' in low or 'phi-3' in low:
        if 'multimodal' in low:
            return (128000, 4096)
        if 'mini' in low:
            return (128000, 16384)
        if 'vision' in low:
            return (128000, 4096)
        if 'moe' in low:
            return (8192, 2048)
        return (128000, 16384)
    if 'gemma' in low:
        if 'gemma-4' in low or 'gemma4' in low:
            return (262144, 8192)
        if 'gemma-3' in low or 'gemma3' in low:
            if '27b' in low:
                return (131072, 8192)
            if '12b' in low:
                return (32768, 8192)
            if '4b' in low:
                return (32768, 8192)
            if '2b' in low:
                return (8192, 2048)
            return (32768, 8192)
        if 'gemma-2' in low or 'gemma2' in low:
            if '2b' in low:
                return (8192, 4096)
            return (8192, 4096)
        if 'codegemma' in low:
            return (8192, 4096)
        return (8192, 2048)
    if 'granite' in low:
        return (8192, 4096)
    if 'minimax' in low:
        return (1048576, 16384)
    if 'kimi' in low or 'moonshot' in low:
        return (131072, 16384)
    if 'seed' in low or 'bytedance' in low:
        return (131072, 8192)
    if 'stepfun' in low or 'step-' in low:
        return (131072, 16384)
    if 'yi-' in low or 'yi/' in low:
        return (200000, 4096)
    if 'abacusai' in low:
        return (128000, 4096)
    if 'dbrx' in low or 'databricks' in low:
        return (32768, 4096)
    if 'jamba' in low or 'ai21' in low:
        return (131072, 8192)
    if 'palmyra' in low or 'writer' in low:
        return (32768, 4096)
    if 'solar' in low or 'upstage' in low:
        return (32768, 4096)
    if 'arctic' in low or 'snowflake' in low:
        return (8192, 2048)
    if 'fuyu' in low:
        return (8192, 2048)
    if 'starcoder' in low or 'bigcode' in low:
        return (8192, 2048)
    if 'sea-lion' in low or 'aisingapore' in low:
        return (4096, 2048)
    if 'baai/bge' in low:
        return (8192, 1024)
    if 'sarvam' in low:
        return (8192, 4096)
    if 'stockmark' in low:
        return (32768, 4096)
    if 'zamba' in low or 'zyphra' in low:
        return (8192, 4096)
    if 'z-ai' in low or 'glm' in low:
        return (131072, 8192)
    if 'gpt-oss' in low:
        return (32768, 4096)
    if 'nv' in low or 'nvidia' in low:
        return (128000, 4096)

    if 0 < params_b <= 3:
        return (8192, 2048)
    elif params_b <= 8:
        return (32768, 4096)
    elif params_b <= 30:
        return (128000, 8192)
    elif params_b <= 100:
        return (128000, 16384)
    else:
        return (128000, 16384)


def _sort_key(entry):
    """
    Sort pinned model (nemotron-3-ultra-550b-a55b) first,
    then by benchmark combinedScore descending (best first),
    then by instruct capability, then alphabetically by name.
    """
    model_id = entry['id'].lower()
    
    # Pin nemotron-3-ultra-550b-a55b as #1 (the most reliable responder)
    if 'nemotron-3-ultra-550b-a55b' in model_id:
        return (0, 0, 0, model_id)
    
    # Benchmark score (negated so higher scores sort first; default 1 puts untested after all ranked)
    bench_score = -entry.get('benchmark', {}).get('combinedScore', -1)
    
    has_instruct = 'instruct' in model_id
    instruct_sort = 0 if has_instruct else 1
    
    # Sort by: benchmark score (desc), then instruct, then alphabetically
    return (1, bench_score, instruct_sort, model_id)


def generate_config(models, bench_lookup, bench_data):
    """Generate VS Code config with benchmark annotations.
    nemotron-3-ultra-550b-a55b is pinned as #1 (user's most reliable model)."""
    # In the new Python format, failed models are in rankings with tasksPassed=0
    rankings_list = bench_data.get('rankings', [])
    failed_set = {e['model'] for e in rankings_list if e.get('coding', {}).get('tasksPassed', 0) == 0}
    
    config = [{
        'name': 'Dubu Nim',
        'vendor': 'customendpoint',
        'apiKey': 'proxy-no-auth-needed',
        'apiType': 'chat-completions',
        'models': []
    }]

    # Add benchmark metadata at top level (like benchmark_data.json)
    config[0]['benchmarkMetadata'] = {
        'lastUpdated': bench_data.get('lastUpdated'),
        'proxyUrl': bench_data.get('proxyUrl', PROXY_URL + '/v1/chat/completions'),
        'totalModelsTested': bench_data.get('totalModelsTested', len(rankings_list)),
        'modelsWorking': bench_data.get('modelsWorking', 0),
        'modelsFailed': bench_data.get('modelsFailed', 0),
        'rankings': rankings_list
    }
    
    for m in models:
        max_in, max_out = get_token_limits(m)
        is_embed = is_embedding_model(m)
        entry = {
            'id': m,
            'name': shorten_name(m),
            'url': f'{PROXY_URL}/v1/chat/completions',
            'chat': not is_embed,  # embedding models can't chat
            'toolCalling': get_tool_capability(m, failed_set),
            'vision': get_vision_capability(m),
            'maxInputTokens': max_in,
            'maxOutputTokens': max_out
        }

        # Add benchmark annotations if available (new Python format)
        if m in bench_lookup:
            b = bench_lookup[m]
            label = get_model_label(b)
            entry['name'] = f'{entry["name"]} ({label})' if label else entry['name']
            entry['label'] = label
            entry['benchmark'] = {
                'rank': b.get('rank'),
                'model': b.get('model'),
                'family': b.get('family'),
                'params': b.get('params'),
                'speed': b.get('speed'),
                'coding': b.get('coding'),
                'combinedScore': b.get('combinedScore'),
            }
        config[0]['models'].append(entry)

    # Sort: pinned nemotron-3-ultra-550b-a55b first, then instruct, then alphabetically
    config[0]['models'].sort(key=_sort_key)

    return config


if __name__ == '__main__':
    # Load benchmark data
    bench_lookup, bench_data = load_benchmark_data()
    has_benchmarks = len(bench_lookup) > 0

    print(f'Fetching models from NVIDIA API ({NVIDIA_API_BASE}/models) ...')
    all_models = fetch_models()
    print(f'  Got {len(all_models)} models total')

    if has_benchmarks:
        print(f'  Loaded benchmark data: {len(bench_lookup)} ranked models')
        # Determine working vs failing from rankings (new Python format)
        rankings_list = bench_data.get('rankings', [])
        failed_set = {e['model'] for e in rankings_list if e.get('coding', {}).get('tasksPassed', 0) == 0}
        working = sum(1 for m in all_models if m in bench_lookup and m not in failed_set)
        failing = sum(1 for m in all_models if m in failed_set)
        unknown = len(all_models) - working - failing
        print(f'  {working} verified working | {failing} known failures | {unknown} untested')

    config = generate_config(all_models, bench_lookup, bench_data)
    CONFIG_PATH.write_text(json.dumps(config, indent='\t', ensure_ascii=False), encoding='utf-8')

    total = len(config[0]['models'])
    ranked = sum(1 for m in config[0]['models'] if 'benchmark' in m)
    print(f'\nDone! {total} models written to {CONFIG_PATH}')
    print(f'  {ranked} models have benchmark annotations')

    vision_count = sum(1 for m in config[0]['models'] if m['vision'])
    tool_count = sum(1 for m in config[0]['models'] if m['toolCalling'])
    print(f'  {vision_count} vision-capable, {tool_count} tool-calling capable')

    embedding_only = sum(1 for m in config[0]['models'] if not m.get('chat', True))
    failed_tool = sum(1 for m in config[0]['models'] if not m.get('toolCalling', True) and not is_embedding_model(m['id']))
    
    print(f'\n  #1 (pinned): {config[0]["models"][0]["name"]}')
    print(f'  First 5 models:')
    for i, m in enumerate(config[0]['models'][:5]):
        annot = ''
        if m.get('benchmark'):
            annot = f' [{m["label"]}]' if m.get('label') else ' [benchmarked]'
        print(f'    {i+1}. {m["name"]}{annot}')
    
    print(f'\n  {embedding_only} embedding-only models (no chat)')
    print(f'  {failed_tool} models with tool calling disabled (failed benchmark or other)')
    print(f'  {tool_count} tool-calling capable')
