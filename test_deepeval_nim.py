"""Quick check that deepeval can drive NVIDIA NIM as an LLM judge.

Requires: pip install deepeval
Usage:
  export NIM_API_KEY=nvapi-...        # bash
  $env:NIM_API_KEY='nvapi-...'        # PowerShell
  python test_deepeval_nim.py
"""
import os
import sys

from deepeval.metrics import AnswerRelevancyMetric
from deepeval.models import GPTModel
from deepeval.test_case import LLMTestCase

API_KEY = os.environ.get("NIM_API_KEY") or os.environ.get("NVIDIA_API_KEY")
if not API_KEY:
    sys.exit("Set NIM_API_KEY first (free key at https://build.nvidia.com/). Keys do not belong in this file.")

nim_judge = GPTModel(
    model=os.environ.get("NIM_JUDGE_MODEL", "openai/gpt-oss-120b"),
    base_url=os.environ.get("NIM_API_BASE", "https://integrate.api.nvidia.com/v1"),
    api_key=API_KEY,
)

metric = AnswerRelevancyMetric(threshold=0.7, model=nim_judge)
tc = LLMTestCase(
    input="Write a Python function to reverse a string",
    actual_output="def reverse(s): return s[::-1]",
    retrieval_context=["Python string slicing can reverse strings"],
)

metric.measure(tc)
print(f"Score: {metric.score}")
print(f"Reason: {metric.reason}")
