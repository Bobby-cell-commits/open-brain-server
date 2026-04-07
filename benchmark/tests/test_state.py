"""Tests for benchmark state management."""

import json
from pathlib import Path
from benchmark.state import BenchmarkState


def test_create_new_state(tmp_path):
    path = tmp_path / "state.json"
    state = BenchmarkState(path, run_id="test-001")
    assert state.run_id == "test-001"
    assert state.brains == {}
    assert state.ingestion == {}


def test_save_and_load(tmp_path):
    path = tmp_path / "state.json"
    state = BenchmarkState(path, run_id="test-001")
    state.add_brain("q_001", "brain-uuid-1", "ob_bench_q001_abc")
    state.save()

    loaded = BenchmarkState.load(path)
    assert loaded.run_id == "test-001"
    assert loaded.brains["q_001"]["brain_id"] == "brain-uuid-1"
    assert loaded.brains["q_001"]["api_key"] == "ob_bench_q001_abc"


def test_record_completed_thought(tmp_path):
    path = tmp_path / "state.json"
    state = BenchmarkState(path, run_id="test-001")
    state.init_brain_ingestion("q_001", total=5)
    state.record_completed("q_001", "q_001_0", thought_id="uuid-thought-1")
    assert "q_001_0" in state.ingestion["q_001"]["completed"]
    assert state.summary["completed"] == 1


def test_record_failed_thought(tmp_path):
    path = tmp_path / "state.json"
    state = BenchmarkState(path, run_id="test-001")
    state.init_brain_ingestion("q_001", total=5)
    state.record_failed("q_001", "q_001_3", "timeout after 3 retries")
    assert state.ingestion["q_001"]["failed"]["q_001_3"] == "timeout after 3 retries"
    assert state.summary["failed"] == 1


def test_record_merged_thought(tmp_path):
    path = tmp_path / "state.json"
    state = BenchmarkState(path, run_id="test-001")
    state.init_brain_ingestion("q_001", total=5)
    state.record_merged("q_001", "q_001_5")
    assert "q_001_5" in state.ingestion["q_001"]["merged"]
    assert state.summary["merged"] == 1


def test_is_completed(tmp_path):
    path = tmp_path / "state.json"
    state = BenchmarkState(path, run_id="test-001")
    state.init_brain_ingestion("q_001", total=5)
    state.record_completed("q_001", "q_001_0", thought_id="uuid-1")
    state.record_merged("q_001", "q_001_1")
    assert state.is_done("q_001", "q_001_0") is True
    assert state.is_done("q_001", "q_001_1") is True
    assert state.is_done("q_001", "q_001_2") is False


def test_brain_already_provisioned(tmp_path):
    path = tmp_path / "state.json"
    state = BenchmarkState(path, run_id="test-001")
    state.add_brain("q_001", "brain-uuid-1", "ob_bench_q001_abc")
    assert state.is_brain_provisioned("q_001") is True
    assert state.is_brain_provisioned("q_002") is False


def test_load_nonexistent_returns_none(tmp_path):
    path = tmp_path / "state.json"
    result = BenchmarkState.load(path)
    assert result is None


def test_summary_counts_accumulate(tmp_path):
    path = tmp_path / "state.json"
    state = BenchmarkState(path, run_id="test-001")
    state.init_brain_ingestion("q_001", total=3)
    state.init_brain_ingestion("q_002", total=2)
    state.record_completed("q_001", "q_001_0", thought_id="u1")
    state.record_completed("q_002", "q_002_0", thought_id="u2")
    state.record_failed("q_001", "q_001_1", "error")
    assert state.summary["total_thoughts"] == 5
    assert state.summary["completed"] == 2
    assert state.summary["failed"] == 1
