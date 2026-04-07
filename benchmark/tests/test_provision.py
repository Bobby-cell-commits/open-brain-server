"""Tests for brain provisioning via Supabase REST API."""

import hashlib
import json
import pytest
from unittest.mock import patch, MagicMock
from benchmark.provision import generate_api_key, hash_key, create_brain, delete_brain


def test_generate_api_key_format():
    key = generate_api_key("q_001")
    assert key.startswith("ob_bench_q_001_")
    assert len(key) == len("ob_bench_q_001_") + 8  # 8-char random suffix


def test_generate_api_key_unique():
    keys = {generate_api_key("q_001") for _ in range(100)}
    assert len(keys) == 100  # all unique


def test_hash_key_matches_deno():
    """Verify Python SHA-256 matches the Deno implementation in auth.ts."""
    key = "ob_bench_test_12345678"
    expected = hashlib.sha256(key.encode()).hexdigest()
    assert hash_key(key) == expected
    # Should be 64 hex chars
    assert len(hash_key(key)) == 64


def test_create_brain_success():
    mock_response_brain = MagicMock()
    mock_response_brain.status_code = 201
    mock_response_brain.json.return_value = [{"id": "brain-uuid-1"}]

    mock_response_key = MagicMock()
    mock_response_key.status_code = 201
    mock_response_key.json.return_value = [{"id": "key-uuid-1"}]

    with patch("benchmark.provision.requests.post") as mock_post:
        mock_post.side_effect = [mock_response_brain, mock_response_key]
        brain_id, api_key = create_brain(
            question_id="q_001",
            supabase_url="https://test.supabase.co",
            service_role_key="test-service-key",
        )
        assert brain_id == "brain-uuid-1"
        assert api_key.startswith("ob_bench_q_001_")

        # Verify brain insert call
        brain_call = mock_post.call_args_list[0]
        assert "/rest/v1/brains" in brain_call.args[0]
        brain_body = brain_call.kwargs["json"]
        assert brain_body["name"] == "longmemeval-q_001"

        # Verify key insert call
        key_call = mock_post.call_args_list[1]
        assert "/rest/v1/brain_api_keys" in key_call.args[0]
        key_body = key_call.kwargs["json"]
        assert key_body["brain_id"] == "brain-uuid-1"
        assert key_body["key_hash"] == hash_key(api_key)
        assert key_body["key_prefix"] == api_key[:8]
        assert key_body["scope"] == "read_write"


def test_delete_brain():
    mock_response = MagicMock()
    mock_response.status_code = 204

    with patch("benchmark.provision.requests.delete") as mock_delete:
        mock_delete.return_value = mock_response
        delete_brain(
            brain_id="brain-uuid-1",
            supabase_url="https://test.supabase.co",
            service_role_key="test-service-key",
        )
        call = mock_delete.call_args
        assert "/rest/v1/brains?id=eq.brain-uuid-1" in call.args[0]
