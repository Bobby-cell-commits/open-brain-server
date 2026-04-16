"""Tests for triage model benchmark."""

import json
from dataclasses import asdict
from unittest.mock import patch, MagicMock

import pytest

from pipeline.benchmark_triage import (
    ModelConfig,
    ItemResult,
    ModelSummary,
    load_checkpoint,
    save_checkpoint_line,
    aggregate_results,
    generate_report,
    verify_model,
    BENCHMARK_DIR,
)
from pipeline.triage import _parse_json_response
from pipeline.eval_triage import score_predictions


def _make_item(item_id, category, actionability, source="reddit", split="train"):
    return {
        "id": item_id,
        "content": f"Test content for {item_id}",
        "source": source,
        "ground_truth": {"category": category, "actionability": actionability},
        "split": split,
    }


def _make_result(item_id, category="learning", actionability="medium",
                 latency_ms=100.0, prompt_tokens=500, completion_tokens=100,
                 error=None):
    return ItemResult(
        item_id=item_id,
        prediction={"category": category, "actionability": actionability},
        latency_ms=latency_ms,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        error=error,
    )


# --- Checkpoint tests ---


def test_checkpoint_save_and_load(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.benchmark_triage.BENCHMARK_DIR", tmp_path)

    results = [
        _make_result("item-1", "learning", "high", 120.0, 500, 100),
        _make_result("item-2", "claude-code", "medium", 200.0, 600, 150),
        _make_result("item-3", "personal", "low", 80.0, 400, 80),
    ]

    for r in results:
        save_checkpoint_line("test-model", r)

    loaded = load_checkpoint("test-model")

    assert len(loaded) == 3
    for r in results:
        assert r.item_id in loaded
        loaded_r = loaded[r.item_id]
        assert loaded_r.prediction == r.prediction
        assert loaded_r.latency_ms == r.latency_ms
        assert loaded_r.prompt_tokens == r.prompt_tokens
        assert loaded_r.completion_tokens == r.completion_tokens


def test_checkpoint_resume_skips_completed(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.benchmark_triage.BENCHMARK_DIR", tmp_path)

    from pipeline.benchmark_triage import run_benchmark_for_model

    # Pre-populate checkpoint with 2 items
    checkpoint_file = tmp_path / "test-model.jsonl"
    for i in range(2):
        line = json.dumps({
            "item_id": f"item-{i}",
            "prediction": {"category": "learning", "actionability": "medium"},
            "latency_ms": 100.0,
            "prompt_tokens": 500,
            "completion_tokens": 100,
            "error": None,
        })
        checkpoint_file.open("a").write(line + "\n")

    config = ModelConfig(
        openrouter_id="test/model",
        display_name="Test Model",
        cost_per_m_input=0.10,
        cost_per_m_output=0.20,
    )

    items = [_make_item(f"item-{i}", "learning", "medium") for i in range(5)]

    mock_prediction = {"category": "learning", "actionability": "medium"}
    mock_meta = {"prompt_tokens": 500, "completion_tokens": 100, "latency_ms": 150.0}

    with patch("pipeline.benchmark_triage._dispatch_triage_with_meta",
               return_value=(mock_prediction, mock_meta)) as mock_dispatch:
        run_benchmark_for_model("test-model", config, items, resume=True)
        assert mock_dispatch.call_count == 3


def test_checkpoint_handles_corrupted_line(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.benchmark_triage.BENCHMARK_DIR", tmp_path)

    checkpoint_file = tmp_path / "corrupt-model.jsonl"
    valid_line = json.dumps({
        "item_id": "item-ok",
        "prediction": {"category": "learning", "actionability": "medium"},
        "latency_ms": 100.0,
        "prompt_tokens": 500,
        "completion_tokens": 100,
        "error": None,
    })
    checkpoint_file.write_text(valid_line + "\n" + "not valid json{{{\n")

    loaded = load_checkpoint("corrupt-model")
    assert len(loaded) == 1
    assert "item-ok" in loaded


# --- Scoring / aggregation tests ---


def test_score_aggregation(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.benchmark_triage.BENCHMARK_DIR", tmp_path)

    config = ModelConfig(
        openrouter_id="test/model",
        display_name="Test Model",
        cost_per_m_input=0.10,
        cost_per_m_output=0.20,
    )

    items = [
        _make_item("i1", "learning", "medium"),
        _make_item("i2", "claude-code", "high"),
        _make_item("i3", "personal", "low"),
        _make_item("i4", "side-projects", "archive"),
    ]

    results = [
        # Perfect match: category + actionability = 2 points
        _make_result("i1", "learning", "medium"),
        # Perfect match: 2 points
        _make_result("i2", "claude-code", "high"),
        # Category matches, actionability wrong: 1 point
        _make_result("i3", "personal", "medium"),
        # Nothing matches: 0 points
        _make_result("i4", "learning", "high"),
    ]

    summary = aggregate_results("test-model", config, items, results)

    # 5 out of 8 total points = 62.5
    assert summary.score == pytest.approx(62.5)
    # 3 out of 4 categories correct = 75.0
    assert summary.category_accuracy == pytest.approx(75.0)
    # 2 out of 4 actionability correct = 50.0
    assert summary.actionability_accuracy == pytest.approx(50.0)


# --- Report generation tests ---


def test_report_generation():
    summaries = [
        ModelSummary(
            model_slug="model-a",
            model_id="vendor/model-a",
            display_name="Model A",
            score=85.0,
            category_accuracy=90.0,
            actionability_accuracy=80.0,
            total_items=50,
            errors=0,
            mean_latency_ms=200.0,
            p50_latency_ms=180.0,
            p95_latency_ms=350.0,
            total_prompt_tokens=25000,
            total_completion_tokens=5000,
            estimated_cost_usd=0.0035,
            cost_per_item_usd=0.00007,
        ),
        ModelSummary(
            model_slug="model-b",
            model_id="vendor/model-b",
            display_name="Model B",
            score=72.0,
            category_accuracy=75.0,
            actionability_accuracy=69.0,
            total_items=50,
            errors=2,
            mean_latency_ms=300.0,
            p50_latency_ms=280.0,
            p95_latency_ms=500.0,
            total_prompt_tokens=25000,
            total_completion_tokens=5000,
            estimated_cost_usd=0.0050,
            cost_per_item_usd=0.0001,
        ),
    ]

    report = generate_report(summaries, "train")

    assert "# Triage Model Benchmark Report" in report
    assert "Model A" in report
    assert "Model B" in report
    assert "85.0" in report
    assert "72.0" in report


# --- JSON parsing tests ---


def test_json_parsing_fallback_fences():
    text = '```json\n{"category": "learning", "actionability": "medium"}\n```'
    result = _parse_json_response(text)
    assert result["category"] == "learning"
    assert result["actionability"] == "medium"


def test_json_parsing_fallback_plain():
    text = '{"category": "learning"}'
    result = _parse_json_response(text)
    assert result["category"] == "learning"


def test_json_parsing_fallback_invalid():
    with pytest.raises(json.JSONDecodeError):
        _parse_json_response("not json at all")


# --- Model verification tests ---


@patch("pipeline.benchmark_triage.requests.post")
def test_verify_model_success(mock_post):
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": "hi"}}],
    }
    mock_resp.raise_for_status = MagicMock()
    mock_post.return_value = mock_resp

    assert verify_model("some/model") is True


@patch("pipeline.benchmark_triage.requests.post")
def test_verify_model_failure(mock_post):
    import requests

    mock_resp = MagicMock()
    mock_resp.status_code = 404
    mock_resp.raise_for_status.side_effect = requests.HTTPError("404 Not Found")
    mock_post.return_value = mock_resp

    assert verify_model("bad/model") is False


# --- Cost calculation tests ---


def test_cost_calculation(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.benchmark_triage.BENCHMARK_DIR", tmp_path)

    config = ModelConfig(
        openrouter_id="test/model",
        display_name="Test Model",
        cost_per_m_input=0.10,
        cost_per_m_output=0.20,
    )

    items = [_make_item(f"i{i}", "learning", "medium") for i in range(5)]
    results = [
        _make_result(f"i{i}", "learning", "medium",
                     prompt_tokens=1000, completion_tokens=200)
        for i in range(5)
    ]

    summary = aggregate_results("test-model", config, items, results)

    # total: 5000 prompt, 1000 completion
    # cost = (5000/1e6)*0.10 + (1000/1e6)*0.20 = 0.0005 + 0.0002 = 0.0007
    assert summary.estimated_cost_usd == pytest.approx(0.0007)
    assert summary.total_prompt_tokens == 5000
    assert summary.total_completion_tokens == 1000
    assert summary.cost_per_item_usd == pytest.approx(0.0007 / 5)


# --- Latency percentile tests ---


def test_latency_percentiles(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.benchmark_triage.BENCHMARK_DIR", tmp_path)

    config = ModelConfig(
        openrouter_id="test/model",
        display_name="Test Model",
        cost_per_m_input=0.10,
        cost_per_m_output=0.20,
    )

    items = [_make_item(f"i{i}", "learning", "medium") for i in range(10)]
    latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    results = [
        _make_result(f"i{i}", "learning", "medium", latency_ms=float(lat))
        for i, lat in enumerate(latencies)
    ]

    summary = aggregate_results("test-model", config, items, results)

    assert summary.mean_latency_ms == pytest.approx(550.0)
    # p50 should be around 500-600 (median of evenly spaced 100-1000)
    assert 450.0 <= summary.p50_latency_ms <= 600.0
    # p95 should be around 950-1000
    assert 900.0 <= summary.p95_latency_ms <= 1050.0


# --- Dry run tests ---


def test_dry_run_limits_items(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.benchmark_triage.BENCHMARK_DIR", tmp_path)

    from pipeline.benchmark_triage import run_benchmark_for_model

    config = ModelConfig(
        openrouter_id="test/model",
        display_name="Test Model",
        cost_per_m_input=0.10,
        cost_per_m_output=0.20,
    )

    items = [_make_item(f"item-{i}", "learning", "medium") for i in range(20)]
    dry_run_items = items[:5]

    mock_prediction = {"category": "learning", "actionability": "medium"}
    mock_meta = {"prompt_tokens": 500, "completion_tokens": 100, "latency_ms": 150.0}

    with patch("pipeline.benchmark_triage._dispatch_triage_with_meta",
               return_value=(mock_prediction, mock_meta)) as mock_dispatch:
        run_benchmark_for_model("test-model", config, dry_run_items, resume=False)
        assert mock_dispatch.call_count == 5


# --- Report-only mode tests ---


def test_report_only_no_api_calls(tmp_path, monkeypatch):
    monkeypatch.setattr("pipeline.benchmark_triage.BENCHMARK_DIR", tmp_path)

    # Pre-populate a checkpoint with results
    items = [_make_item(f"i{i}", "learning", "medium") for i in range(3)]

    checkpoint_file = tmp_path / "test-model.jsonl"
    for i in range(3):
        line = json.dumps({
            "item_id": f"i{i}",
            "prediction": {"category": "learning", "actionability": "medium"},
            "latency_ms": 100.0,
            "prompt_tokens": 500,
            "completion_tokens": 100,
            "error": None,
        })
        checkpoint_file.open("a").write(line + "\n")

    # Mock the labeled data loader to return our items
    with patch("pipeline.benchmark_triage.load_labeled_data", return_value=items), \
         patch("pipeline.benchmark_triage.verify_model") as mock_verify, \
         patch("pipeline.benchmark_triage.run_benchmark_for_model") as mock_run, \
         patch("pipeline.benchmark_triage.CANDIDATE_MODELS", {
             "test-model": ModelConfig(
                 openrouter_id="test/model",
                 display_name="Test Model",
                 cost_per_m_input=0.10,
                 cost_per_m_output=0.20,
             ),
         }), \
         patch("sys.argv", ["benchmark_triage", "--report"]):

        from pipeline.benchmark_triage import main
        main()

        mock_verify.assert_not_called()
        mock_run.assert_not_called()

    # Check report was generated
    report_files = list(tmp_path.glob("report*.md"))
    assert len(report_files) >= 1
