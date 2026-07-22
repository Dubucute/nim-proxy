"""Quick test: deepeval with NVIDIA NIM as judge."""
import os
from deepeval.metrics import AnswerRelevancyMetric
from deepeval.test_case import LLMTestCase

# Configure deepeval to use NVIDIA NIM
from deepeval.models import GPTModel

nim_judge = GPTModel(
    model="openai/gpt-oss-120b",
    base_url="https://integrate.api.nvidia.com/v1",
    api_key="nvapi-REVOKED-KEY-REMOVED"
)

metric = AnswerRelevancyMetric(threshold=0.7, model=nim_judge)
tc = LLMTestCase(
    input="Write a Python function to reverse a string",
    actual_output="def reverse(s): return s[::-1]",
    retrieval_context=["Python string slicing can reverse strings"]
)

metric.measure(tc)
print(f"Score: {metric.score}")
print(f"Reason: {metric.reason}")
