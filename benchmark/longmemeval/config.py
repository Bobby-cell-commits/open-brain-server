"""LongMemEval-specific configuration."""

from benchmark.config import SOURCE

# Dataset
DATASET_NAME = "xiaowu0162/longmemeval-cleaned"
DATASET_SPLIT = "test"

# Ingestion
BENCHMARK_SOURCE = SOURCE  # "benchmark"

# Eval
READER_MODEL = "openai/gpt-4o-mini"
JUDGE_MODEL = "gpt-4o-2024-08-06"
RETRIEVAL_LIMIT = 20
RETRIEVAL_THRESHOLD = 0.4
RETRIEVAL_EXPAND = True
RETRIEVAL_MIN_QUALITY = 0
