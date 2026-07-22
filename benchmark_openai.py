"""
NVIDIA NIM OpenAI Benchmark (nvext)
====================================
Tests ALL models using OpenAI SDK with NVIDIA's nvext server-side timing.

Metrics: tool calling, TTFT (client+server), tokens/sec, code quality,
         cache efficiency (kv_hit_rate), instruction following,
         output length utilization, server load (router_queue_depth)

Usage:
    python benchmark_openai.py
    python benchmark_openai.py --models 10
    python benchmark_openai.py --models deepseek
    python benchmark_openai.py --dry-run
"""
from __future__ import annotations
import argparse, json, os, re, sys, time, textwrap, traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from openai import OpenAI
import requests

# ── Constants ──
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
MODELS_URL = f"{NVIDIA_BASE_URL}/models"
ARTIFACTS_DIR = Path(__file__).parent / "benchmark_artifacts"
REPORT_FILE = ARTIFACTS_DIR / "openai_report.txt"
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

# ── API keys ──
def _collect_api_keys():
    keys = []
    for var in ["NVIDIA_API_KEY", "NIM_API_KEY", "NVIDIA_NIM_API_KEY"]:
        v = os.environ.get(var)
        if v: keys.append(v); break
    for s in ["_2","_3","_4","_5"]:
        k = os.environ.get(f"NIM_API_KEY{s}") or os.environ.get(f"NVIDIA_API_KEY{s}")
        if k: keys.append(k)
    if not keys:
        keys = ["nvapi-REVOKED-KEY-REMOVED",
                "nvapi-REVOKED-KEY-REMOVED",
                "nvapi-REVOKED-KEY-REMOVED"]
    return keys

API_KEYS = _collect_api_keys()
_key_idx = 0

def _next_key():
    """Non-blocking round-robin across API keys."""
    global _key_idx
    i = _key_idx % len(API_KEYS); _key_idx += 1
    return API_KEYS[i]


# ── Model catalog ──
_NON_CHAT = re.compile(r"embed|guard|safety|translate|gliner|parse|reward|clip|nv-embed|nemoretriever|bge|arctic-embed|deplot|fuyu|kosmos|vila|nvclip|synthetic-video|cosmos|riva|diffusiongemma|recurrentgemma", re.I)
_VISION = re.compile(r"vision|vl\b|vlm|nano-vl", re.I)
_REASON = re.compile(r"reason|think|chain", re.I)

@dataclass
class ModelEntry:
    id: str; owned_by: str; tags: list = field(default_factory=list)

def fetch_models():
    h = {"Authorization":f"Bearer {_next_key()}","Content-Type":"application/json"}
    try:
        r = requests.get(MODELS_URL, headers=h, timeout=15); r.raise_for_status()
        api = r.json().get("data",[])
    except:
        return _default()
    entries, seen = [], set()
    for m in api:
        mid, owner = m["id"], m.get("owned_by","")
        if _NON_CHAT.search(mid) or mid in seen: continue
        seen.add(mid)
        tags = []
        if _VISION.search(mid): tags.append("vision")
        if _REASON.search(mid): tags.append("reasoning")
        if "instruct" in mid or "chat" in mid or re.search(r"(llama|mistral|qwen|deepseek|nemotron|gpt-oss|step-|phi-)",mid,re.I): tags.append("tool")
        entries.append(ModelEntry(mid, owner, tags))
    return entries

def _default():
    ids = ["nvidia/nemotron-3-nano-30b-a3b","openai/gpt-oss-20b","mistralai/mistral-small-4-119b-2603","meta/llama-3.1-8b-instruct","deepseek-ai/deepseek-v4-flash","nvidia/nemotron-3-ultra-550b-a55b"]
    return [ModelEntry(i,i.split("/")[0]) for i in ids]

def filter_models(es, pat):
    if not pat: return es
    if pat.isdigit(): return es[:int(pat)]
    return [e for e in es if pat.lower() in e.id.lower()]

# ── Tools ──
def _build_tools():
    base = [("create_file","Create file",{"filePath":"string","content":"string"},["filePath","content"]),
            ("replace_string_in_file","Replace text",{"filePath":"string","oldString":"string","newString":"string"},["filePath","oldString","newString"]),
            ("read_file","Read file",{"filePath":"string","startLine":"number","endLine":"number"},["filePath"]),
            ("run_in_terminal","Run shell",{"command":"string","explanation":"string"},["command","explanation"]),
            ("grep_search","Search text",{"query":"string","isRegexp":"boolean"},["query","isRegexp"]),
            ("file_search","Find files",{"query":"string"},["query"]),
            ("list_dir","List dir",{"path":"string"},["path"]),
            ("create_directory","Create dirs",{"dirPath":"string"},["dirPath"]),
            ("fetch_webpage","Fetch URL",{"urls":"array","query":"string"},["urls","query"]),
            ("memory","Manage memory",{"command":"string","path":"string"},["command"])]
    for i in range(30): base.append((f"tool_{i:02d}",f"Auto tool #{i}",{"input":"string","config":"string"},["input"]))
    tools = []
    for n,d,p,r in base:
        tools.append({"type":"function","function":{"name":n,"description":d,"parameters":{"type":"object","properties":{k:{"type":v} for k,v in p.items()},"required":r}}})
    return tools

TOOLS = _build_tools()

# ── Payload builders ──
def _sys_prompt(rez=False):
    b = "You are an expert AI programming assistant. Follow requirements carefully. Keep answers short. Write clean code with error handling."
    if rez: b += "\nThink step by step. Show chain of thought."
    return b

TOOL_MSGS = [{"role":"system","content":_sys_prompt()},
             {"role":"user","content":"<userRequest>\ncreate a benchmark script\n</userRequest>"},
             {"role":"assistant","content":"I'll create a benchmark script."},
             {"role":"user","content":"<userRequest>\nrun the benchmark\n</userRequest>"}]

REASON_PROMPT = "Design a distributed task queue in Python with Redis, retry, prioritization, metrics."
VIS_PROMPT = "Describe this image."
VIS_URL = "https://upload.wikimedia.org/wikipedia/en/7/7d/Lenna_%28test_image%29.png"
STREAM_MSGS = [{"role":"system","content":"Be concise."},{"role":"user","content":"Write a Python fibonacci function."}]

def build_kwargs(entry):
    kw = {"model":entry.id,"temperature":0.1,"max_tokens":4096}
    if "reasoning" in entry.tags:
        kw["messages"]=[{"role":"system","content":_sys_prompt(True)},{"role":"user","content":REASON_PROMPT}]; kw["temperature"]=0.3
    elif "vision" in entry.tags:
        kw["messages"]=[{"role":"system","content":_sys_prompt()},{"role":"user","content":[{"type":"text","text":VIS_PROMPT},{"type":"image_url","image_url":{"url":VIS_URL}}]}]; kw["max_tokens"]=1024; kw["temperature"]=0.2
    else:
        kw["messages"]=TOOL_MSGS; kw["tools"]=TOOLS; kw["tool_choice"]="auto"
    return kw

# ── Result ──
@dataclass
class Result:
    model: str; tags: list; owner: str; status: str = "ok"
    duration_s: float = 0.0; input_tokens: int = 0; output_tokens: int = 0
    tool_call_count: int = 0; has_tool_calls: bool = False; score: float = 0.0
    ttft_ms: float = 0.0; server_ttft_ms: float = 0.0; tokens_per_sec: float = 0.0
    kv_hit_rate: float = 0.0; prefIll_ms: float = 0.0; server_total_ms: float = 0.0
    router_queue: int = 0
    code_compiles: bool = False; quality_checks: int = 0; quality_total: int = 0
    follows_instructions: bool = False
    token_utilization: float = 0.0
    judge_score: float = 0.0
    judge_reason: str = ""
    combinedScore: int = 0
    error: str = ""; output_preview: str = ""

def _nvext(resp) -> dict:
    try: return json.loads(resp.model_dump_json()).get("nvext",{}).get("timing",{})
    except: return {}

def _make_client():
    return OpenAI(api_key=_next_key(), base_url=NVIDIA_BASE_URL, timeout=120)


# ── Judge evaluation (post-benchmark, single threaded) ──
_JUDGE_MODEL = "nvidia/nemotron-3-nano-30b-a3b"

def _judge_code(input_text: str, code: str) -> tuple[float, str]:
    """Ask judge to rate code quality 0.0-1.0 with reasoning."""
    client = _make_client()
    prompt = f"""You are a STRICT AI assistant evaluator. Rate the response 0.0-1.0.
- If the response contains tool calls (e.g. create_file, run_in_terminal), it's following instructions — score high.
- If it just talks without doing anything useful — score low.
- Deduct for missing error handling, incomplete logic, poor style.
Only give 1.0 for perfect responses.

First give a brief 1-sentence reason, then a single number on the last line.

Input: {input_text[:200]}

Response:
{code[:1000]}

Reason:"""
    try:
        resp = client.chat.completions.create(
            model=_JUDGE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=128, temperature=0.1
        )
        text = (resp.choices[0].message.content or "").strip()
        import re as _re
        m = _re.search(r"(\d+\.?\d*)", text.split("\n")[-1])  # last line number
        score = max(0.0, min(1.0, float(m.group(1)))) if m else 0.5
        reason = text[:200].replace("\n", " ")
        return score, reason
    except Exception as e:
        return 0.5, str(e)[:100]


def _run_judges(results: list) -> list:
    """Evaluate ALL working models with judge (sequential)."""
    working = [r for r in results if r.status == "ok"]
    if not working:
        return results
    print(f"\n  [judge] ({_JUDGE_MODEL}) evaluating {len(working)} working models...\n")
    for i, r in enumerate(working, 1):
        preview = r.output_preview or f"[Tool calls: {r.tool_call_count}]"
        score, reason = _judge_code(r.model, preview)
        r.judge_score = score
        r.judge_reason = reason
        r.combinedScore = _calc_combined(r)
        print(f"  [{i}/{len(working)}] {r.model:<50} judge={score:.2f}  combined={r.combinedScore}")
        print(f"       -> {reason}")
    return results


# ── Batch runner ──
def run_benchmark(entries, parallel=5):
    print(f"\n  Running {len(entries)} models ({parallel} tool + {parallel} stream threads)...\n")
    results, total = [], len(entries)
    # Two separate pools so streaming doesn't queue behind tool tests
    from concurrent.futures import FIRST_COMPLETED, wait
    tool_futs, stream_futs = {}, {}
    
    with ThreadPoolExecutor(max_workers=parallel) as tool_pool, \
         ThreadPoolExecutor(max_workers=parallel) as stream_pool:
        
        # Start initial batch of tool tests
        remaining = iter(entries)
        for _ in range(parallel):
            e = next(remaining, None)
            if e:
                kw = build_kwargs(e)
                tool_futs[tool_pool.submit(_test_tool, e, kw)] = e
        
        completed = 0
        while tool_futs or stream_futs or completed < total:
            # Wait for ANY tool or stream test to finish
            all_futs = list(tool_futs.keys()) + list(stream_futs.keys())
            if not all_futs:
                break
            done, _ = wait(all_futs, return_when=FIRST_COMPLETED, timeout=300)
            
            for f in done:
                if f in tool_futs:
                    e = tool_futs.pop(f)
                    try:
                        r = f.result()
                        # Submit streaming test immediately (fresh worker)
                        sf = stream_pool.submit(_test_stream, r, e)
                        stream_futs[sf] = (r, e)
                    except Exception as ex:
                        completed += 1
                        r = Result(e.id,e.tags,e.owned_by,"error",error=str(ex)[:300])
                        results.append(r)
                        _print_result(completed, total, r)
                    # Start next tool test
                    next_e = next(remaining, None)
                    if next_e:
                        kw = build_kwargs(next_e)
                        tool_futs[tool_pool.submit(_test_tool, next_e, kw)] = next_e
                
                elif f in stream_futs:
                    r, e = stream_futs.pop(f)
                    completed += 1
                    try:
                        r = f.result()
                        results.append(r)
                    except Exception as ex:
                        r = Result(e.id,e.tags,e.owned_by,"error",error=str(ex)[:300])
                        results.append(r)
                    _print_result(completed, total, r)
    
    return results


def _calc_combined(r: Result) -> int:
    """Combined score: tool calling (50%) + judge (30%) + speed (20%)."""
    tool_score = r.score / 100.0
    judge_score = r.judge_score  # 0.00 means judge gave it 0 — we use it as-is
    
    ttft_s = 0
    if r.server_ttft_ms:
        if r.server_ttft_ms < 100: ttft_s = 1.0
        elif r.server_ttft_ms < 300: ttft_s = 0.9
        elif r.server_ttft_ms < 500: ttft_s = 0.8
        elif r.server_ttft_ms < 1000: ttft_s = 0.6
        elif r.server_ttft_ms < 3000: ttft_s = 0.4
        elif r.server_ttft_ms < 10000: ttft_s = 0.2
        else: ttft_s = 0.1
    elif r.ttft_ms:
        if r.ttft_ms < 300: ttft_s = 0.8
        elif r.ttft_ms < 500: ttft_s = 0.6
        elif r.ttft_ms < 1000: ttft_s = 0.5
        elif r.ttft_ms < 3000: ttft_s = 0.3
        elif r.ttft_ms < 10000: ttft_s = 0.15
        else: ttft_s = 0.05
    
    tps_s = min(1.0, r.tokens_per_sec / 100) if r.tokens_per_sec else 0
    speed_score = ttft_s * 0.6 + tps_s * 0.4
    
    return round(tool_score * 50 + judge_score * 30 + speed_score * 20)


def _print_result(i, total, r):
    icon = "[OK]" if r.status == "ok" else "[ERR]"
    line = f"  [{i}/{total}] {icon} {r.model:<50} score={r.score:>5}%  tools={r.tool_call_count}"
    if r.server_ttft_ms: line += f"  nvTTFT={r.server_ttft_ms:.0f}ms"
    elif r.ttft_ms: line += f"  TTFT={r.ttft_ms:.0f}ms"
    if r.tokens_per_sec: line += f"  TPS={r.tokens_per_sec:.1f}"
    if r.judge_score: line += f"  judge={r.judge_score:.2f}"
    if r.combinedScore: line += f"  combined={r.combinedScore}"
    if r.error: line += f"  -> {r.error[:150]}"
    print(line)


def _test_tool(entry, kw) -> Result:
    """Run tool/non-streaming test only."""
    r = Result(model=entry.id, tags=entry.tags, owner=entry.owned_by)
    client = _make_client()
    try:
        start = time.perf_counter()
        resp = client.chat.completions.create(**kw)
        elapsed = time.perf_counter() - start

        nv = _nvext(resp)
        r.server_ttft_ms = nv.get("ttft_ms",0)
        r.prefIll_ms = nv.get("prefill_time_ms",0)
        r.server_total_ms = nv.get("total_time_ms",0)
        r.kv_hit_rate = nv.get("kv_hit_rate",0)
        r.router_queue = nv.get("router_queue_depth",0)
        r.duration_s = elapsed
        r.input_tokens = resp.usage.prompt_tokens if resp.usage else 0
        r.output_tokens = resp.usage.completion_tokens if resp.usage else 0

        msg = resp.choices[0].message if resp.choices else None
        if msg:
            tc = msg.tool_calls or []
            content = msg.content or ""
            r.has_tool_calls = len(tc) > 0
            r.tool_call_count = len(tc)
            r.output_preview = content[:120]

            if tc:
                valid = sum(1 for t in tc if t.function.name.startswith(("create_","read_","replace_","run_","grep_","file_","list_","fetch_","memory","tool_")))
                r.score = round(valid/len(tc)*100,1)
            elif content:
                r.score = 30.0

            # Quality checks
            code = content.strip()
            if "```python" in code:
                code = code.split("```python")[1].split("```")[0].strip()
            try: compile(code,"<test>","exec"); r.code_compiles = True
            except: pass

            checks = [bool(re.search(r"def \w+",content)),
                      bool(re.search(r"class \w+",content)) or "import" in content,
                      bool(re.search(r'""".*"""',content,re.DOTALL)) or "'''" in content,
                      "return" in content,
                      "try" in content or "except" in content or "raise" in content]
            r.quality_checks, r.quality_total = sum(checks), len(checks)

            low = content.lower()
            r.follows_instructions = "benchmark" in low or "script" in low or "test" in low or "run" in low
            r.token_utilization = round(r.output_tokens / kw.get("max_tokens", 4096), 3)
    except Exception as e:
        r.status, r.error = "error", str(e)[:300]
    return r


def _test_stream(r: Result, entry: ModelEntry) -> Result:
    """Run streaming test and fill in TTFT/TPS."""
    client = _make_client()
    try:
        start = time.perf_counter()
        first_token = None; tokens = 0; text = ""
        stream = client.chat.completions.create(model=entry.id, messages=STREAM_MSGS, stream=True, max_tokens=256, temperature=0.1, timeout=60)
        for chunk in stream:
            if first_token is None:
                first_token = time.perf_counter()
                r.ttft_ms = (first_token-start)*1000
            d = chunk.choices[0].delta if chunk.choices else None
            if d and d.content:
                tokens += 1; text += d.content
        total = time.perf_counter()-start
        if r.ttft_ms == 0: r.ttft_ms = total/2
        r.tokens_per_sec = round(tokens/total,1) if total > 0 else 0
        if not r.output_preview: r.output_preview = text[:120]
    except Exception as e:
        if not r.error: r.error = f"stream: {str(e)[:80]}"
    return r

# ── Report ──
def generate_report(entries, results, duration):
    ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    sorted_r = sorted(results, key=lambda r: -r.score)
    L = []
    L.append("="*100); L.append(f"  NVIDIA NIM — OPENAI BENCHMARK  ({ts})"); L.append("="*100)
    L.append(f"  nvext timing")
    L.append(f"  Models: {len(results)}/{len(entries)} | Keys: {len(API_KEYS)} | Duration: {duration:.0f}s")
    L.append("")
    L.append("─"*130)
    L.append(f"  {'Model':<45} {'Tool':>5} {'Score':>6} {'TTFT':>7} {'nTTFT':>7} {'TPS':>6} {'KV%':>5} {'RtrQ':>5} {'Util':>5} {'Inst':>4}  Preview")
    L.append("  "+"─"*128)
    for r in sorted_r:
        s = f"{r.score}%" if r.status=="ok" else "ERR"
        tt = f"{r.ttft_ms:.0f}ms" if r.ttft_ms>0 else "-"
        nt = f"{r.server_ttft_ms:.0f}ms" if r.server_ttft_ms>0 else "-"
        tp = f"{r.tokens_per_sec:.1f}" if r.tokens_per_sec>0 else "-"
        kv = f"{r.kv_hit_rate:.0%}" if r.kv_hit_rate else "-"
        rq = f"{r.router_queue:.0f}" if r.router_queue else "-"
        ut = f"{r.token_utilization:.0%}" if r.token_utilization else "-"
        inst = "✓" if r.follows_instructions else "✗"
        pv = r.output_preview[:50].replace("\n"," ")
        L.append(f"  {r.model:<45} {r.tool_call_count:>5} {s:>6} {tt:>7} {nt:>7} {tp:>6} {kv:>5} {rq:>5} {ut:>5} {inst:>4}  {pv}")
    L.append("")
    L.append("─"*110)
    L.append("  STREAMING TTFT RANKING")
    L.append("─"*110)
    st = sorted([r for r in results if r.ttft_ms>0], key=lambda r: r.ttft_ms)
    L.append(f"  {'Model':<50} {'ClientTTFT':>10} {'SrvTTFT':>10} {'TPS':>8}")
    for r in st:
        L.append(f"  {r.model:<50} {r.ttft_ms:>10.0f}ms {r.server_ttft_ms:>10.0f}ms {r.tokens_per_sec:>8.1f}")
    L.append("")
    errs = [r for r in results if r.status=="error"]
    if errs:
        L.append("─"*110); L.append(f"  ERRORS ({len(errs)})"); L.append("─"*110)
        for r in errs: L.append(f"  [ERR] {r.model:<50} {r.error[:150]}")
        L.append("")
    
    # ── Judge evaluation ──
    judged = [r for r in results if r.judge_score > 0]
    if judged:
        L.append("─"*100); L.append(f"  JUDGE EVALUATION ({_JUDGE_MODEL})"); L.append("─"*100)
        L.append(f"  {'Model':<45} {'Judge':>6} {'Combined':>9}  Reason")
        L.append("  "+"─"*90)
        for r in sorted(judged, key=lambda x: -x.combinedScore):
            reason = r.judge_reason[:70] if r.judge_reason else "-"
            L.append(f"  {r.model:<45} {r.judge_score:.2f} {r.combinedScore:>9}  {reason}")
    
    # ── Combined ranking ──
    combined = sorted(results, key=lambda r: -r.combinedScore)
    L.append("")
    L.append("─"*80); L.append("  COMBINED RANKING (tool 50% + judge 30% + speed 20%)"); L.append("─"*80)
    L.append(f"  {'#':<4} {'Model':<50} {'Tool':>6} {'Judge':>6} {'Speed':>6} {'Total':>6}")
    for i, r in enumerate(combined[:30], 1):
        if r.status == "error" and r.combinedScore == 0: continue
        tool_pct = f"{r.score}%" if r.status=="ok" else "ERR"
        judge_pct = f"{r.judge_score:.2f}" if r.judge_score > 0 else "0.00"
        speed_s = _calc_speed_pct(r)
        L.append(f"  {i:<4} {r.model:<50} {tool_pct:>6} {judge_pct:>6} {speed_s:>6} {r.combinedScore:>6}")
    
    rep = "\n".join(L)
    with open(REPORT_FILE,"w",encoding="utf-8") as f: f.write(rep)
    
    # ── Save benchmark_data.json ──
    bench_out = Path(__file__).parent / "benchmark_data.json"
    rankings = []
    for r in combined:
        if r.status != "ok": continue
        rankings.append({
            "rank": 0,
            "model": r.model,
            "params": 0,
            "family": "",
            "speed": {
                "responseTimeSec": round(r.ttft_ms/1000, 2) if r.ttft_ms else 0,
                "ttftMs": round(r.ttft_ms, 0) if r.ttft_ms else 0,
                "tokensPerSec": r.tokens_per_sec or 0,
                "rank": "fast" if r.ttft_ms and r.ttft_ms < 500 else "medium" if r.ttft_ms and r.ttft_ms < 2000 else "slow" if r.ttft_ms else "unknown",
            },
            "coding": {
                "toolCallCount": r.tool_call_count,
                "toolCallScore": r.score,
                "judgeScore": r.judge_score,
            },
            "combinedScore": r.combinedScore,
            "status": r.status,
        })
    for i, r in enumerate(rankings):
        r["rank"] = i + 1
        if not r["family"]: r["family"] = r["model"].split("/")[0]
    with open(bench_out, "w", encoding="utf-8") as f:
        json.dump({
            "lastUpdated": ts,
            "proxyUrl": "https://dubu.alwaysdata.net/v1",
            "totalModelsTested": len(results),
            "modelsWorking": sum(1 for r in results if r.status=="ok"),
            "modelsFailed": sum(1 for r in results if r.status=="error"),
            "rankings": rankings,
        }, f, indent=2, ensure_ascii=False)
    print(f"  [json] {bench_out}")
    
    print(f"\n  [report] {REPORT_FILE}")
    print(rep)


def _calc_speed_pct(r: Result) -> str:
    ttft = r.server_ttft_ms or r.ttft_ms or 0
    tps = r.tokens_per_sec or 0
    if ttft == 0 and tps == 0: return "0%"
    ttft_s = 1.0
    if ttft > 0:
        if ttft < 100: ttft_s = 1.0
        elif ttft < 300: ttft_s = 0.9
        elif ttft < 500: ttft_s = 0.8
        elif ttft < 1000: ttft_s = 0.6
        elif ttft < 3000: ttft_s = 0.4
        elif ttft < 10000: ttft_s = 0.2
        else: ttft_s = 0.1
    tps_s = min(1.0, tps / 100) if tps else 0
    return f"{round((ttft_s * 0.6 + tps_s * 0.4) * 100)}%"

# ── CLI ──
def parse_args():
    p = argparse.ArgumentParser(description="NVIDIA NIM OpenAI Benchmark (nvext)")
    p.add_argument("--models","-m",help="Filter: N (top N) or name substring")
    p.add_argument("--dry-run",action="store_true")
    p.add_argument("--parallel","-p",type=int,default=5,help="Concurrent models (default: 5)")
    return p.parse_args()

def main():
    args = parse_args()
    print("="*100); print("  NVIDIA NIM — OPENAI BENCHMARK (nvext)"); print("="*100)
    print(f"  API keys: {len(API_KEYS)} | Parallel: {args.parallel}")
    print(f"\n  Fetching models...")
    all_e = fetch_models()
    entries = filter_models(all_e, args.models)
    print(f"  {len(all_e)} chat models, testing {len(entries)}")
    if not entries: print("  No models."); sys.exit(0)
    if args.dry_run:
        print("\n--- DRY RUN ---"); print(f"  Models ({len(entries)}):")
        for e in entries: print(f"    - {e.id} [{','.join(e.tags)}]")
        print(f"  API keys: {len(API_KEYS)}")
        print(f"  Parallel: {args.parallel}"); print("--- end ---"); return
    start = time.time()
    results = run_benchmark(entries, parallel=args.parallel)
    results = _run_judges(results)
    generate_report(entries, results, time.time()-start)
    print(f"\nDone in {time.time()-start:.0f}s")

if __name__ == "__main__": main()
