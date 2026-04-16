# Open Brain Benchmark Results

## LongMemEval (2026-04-07)

**Overall score: 37.2%** on the LongMemEval long-term memory benchmark — N=500 questions, baseline run.

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) is a public benchmark for long-term memory in conversational assistants. It evaluates whether an assistant can answer questions that require retrieving facts from long conversational histories, split across six failure-mode categories.

### Per-category breakdown

| Category | Score | Correct / Total | What it measures |
|----------|------:|---------------:|------------------|
| single-session-assistant  | 69.6% | 39 / 56  | Retrieval of facts the assistant said earlier in a session |
| single-session-user       | 55.7% | 39 / 70  | Retrieval of facts the user said earlier in a session |
| knowledge-update          | 52.6% | 41 / 78  | Handling superseded facts (user updates prior info) |
| temporal-reasoning        | 30.8% | 41 / 133 | Queries requiring time-ordering of retrieved facts |
| multi-session             | 18.8% | 25 / 133 | Retrieval across separate sessions |
| single-session-preference |  3.3% |  1 / 30  | Stated preferences deep inside a long session |

### What the score means

- **Honest baseline.** This run predates `deep_search` (multi-hop graph traversal + LLM gap-filling, shipped 2026-04-13), the entity-bridge graph layer (~34K cross-cluster edges, shipped 2026-04-14), and the source filter (shipped 2026-04-14). All three target the categories Open Brain currently scores lowest on.
- **Retrieval is the bottleneck.** 81.5% of multi-session failures are pure retrieval misses — the reader model gets the right answer when the correct evidence is in context.
- **Estimated post-`deep_search` range: 35–45% overall.** Not yet re-run. The next benchmark will run on the local Docker stack — the 21K benchmark thoughts bloated the Supabase HNSW index past `shared_buffers` and depleted the project's disk IO budget.

### Configuration

| Parameter            | Value                   |
|----------------------|-------------------------|
| Reader model         | `openai/gpt-4o-mini`    |
| Judge model          | `gpt-4o-2024-08-06`     |
| Retrieval limit      | 20                      |
| Retrieval threshold  | 0.4                     |
| Graph expansion      | on (1-hop)              |
| Min quality gate     | 0 (disabled)            |

### Reproducing

```bash
python -m benchmark longmemeval provision   # ingest dataset into Open Brain
python -m benchmark longmemeval run         # run queries through the MCP retrieval path
python -m benchmark longmemeval evaluate    # LLM-judge scoring
```

Harness code: [`benchmark/longmemeval/`](benchmark/longmemeval/). Dataset: [`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned).

### Why publish this

Most "memory for LLMs" systems don't publish retrieval benchmarks. Naming a number — even an honest baseline — makes claims falsifiable. This page is updated as retrieval features ship.
