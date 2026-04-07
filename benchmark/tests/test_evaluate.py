"""Tests for benchmark/longmemeval/evaluate.py."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from aioresponses import aioresponses

from benchmark.longmemeval.evaluate import (
    format_memories,
    generate_answer,
    judge_answer,
    score_results,
    evaluate_question,
)


# ---------------------------------------------------------------------------
# format_memories
# ---------------------------------------------------------------------------


def test_format_memories_basic():
    thoughts = [
        {"content": "Alice likes cats.", "created_at": "2024-01-10T08:00:00Z"},
        {"content": "Bob prefers dogs.", "created_at": "2024-01-11T09:00:00Z"},
    ]
    result = format_memories(thoughts)
    assert "1." in result
    assert "2." in result
    assert "[2024-01-10T08:00:00Z] Alice likes cats." in result
    assert "[2024-01-11T09:00:00Z] Bob prefers dogs." in result


def test_format_memories_no_timestamp():
    thoughts = [{"content": "No timestamp here."}]
    result = format_memories(thoughts)
    assert "1. No timestamp here." in result
    # No bracket timestamp prefix
    assert "[" not in result


def test_format_memories_empty():
    result = format_memories([])
    assert result == "(no memories retrieved)"


def test_format_memories_ordering():
    thoughts = [
        {"content": "First memory."},
        {"content": "Second memory."},
        {"content": "Third memory."},
    ]
    result = format_memories(thoughts)
    lines = result.strip().splitlines()
    assert len(lines) == 3
    assert lines[0].startswith("1.")
    assert lines[1].startswith("2.")
    assert lines[2].startswith("3.")


# ---------------------------------------------------------------------------
# generate_answer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_answer_success():
    thoughts = [
        {"content": "Alice's favourite colour is blue.", "created_at": "2024-03-01"},
    ]
    mock_response = {
        "choices": [{"message": {"content": "Alice's favourite colour is blue."}}]
    }

    with aioresponses() as mocked:
        mocked.post(
            "https://openrouter.ai/api/v1/chat/completions",
            payload=mock_response,
            status=200,
        )
        result = await generate_answer(
            query="What is Alice's favourite colour?",
            thoughts=thoughts,
            api_key="test-key",
        )

    assert result == "Alice's favourite colour is blue."


@pytest.mark.asyncio
async def test_generate_answer_empty_thoughts():
    mock_response = {
        "choices": [{"message": {"content": "I don't know."}}]
    }

    with aioresponses() as mocked:
        mocked.post(
            "https://openrouter.ai/api/v1/chat/completions",
            payload=mock_response,
            status=200,
        )
        result = await generate_answer(
            query="What is Alice's favourite colour?",
            thoughts=[],
            api_key="test-key",
        )

    assert result == "I don't know."


@pytest.mark.asyncio
async def test_generate_answer_retries_on_500():
    """Should retry on 500 and succeed on the second attempt."""
    success_response = {
        "choices": [{"message": {"content": "Paris."}}]
    }

    with aioresponses() as mocked:
        mocked.post(
            "https://openrouter.ai/api/v1/chat/completions",
            status=500,
        )
        mocked.post(
            "https://openrouter.ai/api/v1/chat/completions",
            payload=success_response,
            status=200,
        )
        result = await generate_answer(
            query="What city?",
            thoughts=[{"content": "The city is Paris."}],
            api_key="test-key",
            backoff_base=0.0,  # no real sleep in tests
        )

    assert result == "Paris."


@pytest.mark.asyncio
async def test_generate_answer_raises_after_max_retries():
    with aioresponses() as mocked:
        for _ in range(3):
            mocked.post(
                "https://openrouter.ai/api/v1/chat/completions",
                status=500,
            )
        with pytest.raises(RuntimeError, match="failed after"):
            await generate_answer(
                query="question",
                thoughts=[],
                api_key="test-key",
                max_retries=3,
                backoff_base=0.0,
            )


# ---------------------------------------------------------------------------
# judge_answer
# ---------------------------------------------------------------------------


def _make_openai_response(content: str):
    """Build a mock openai ChatCompletion response object."""
    msg = MagicMock()
    msg.content = content
    choice = MagicMock()
    choice.message = msg
    response = MagicMock()
    response.choices = [choice]
    return response


@pytest.mark.asyncio
async def test_judge_answer_correct():
    verdict = "yes\nThe generated answer matches the gold answer exactly."

    mock_client = MagicMock()
    mock_client.close = AsyncMock()
    mock_client.chat = MagicMock()
    mock_client.chat.completions = MagicMock()
    mock_client.chat.completions.create = AsyncMock(
        return_value=_make_openai_response(verdict)
    )

    with patch("benchmark.longmemeval.evaluate.AsyncOpenAI", return_value=mock_client):
        result = await judge_answer(
            question="What is Alice's favourite colour?",
            generated_answer="Alice's favourite colour is blue.",
            gold_answer="blue",
            category="single-session-user",
            api_key="test-openai-key",
        )

    assert result["correct"] is True
    assert "matches" in result["reasoning"]


@pytest.mark.asyncio
async def test_judge_answer_incorrect():
    verdict = "no\nThe generated answer says red but the gold answer is blue."

    mock_client = MagicMock()
    mock_client.close = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(
        return_value=_make_openai_response(verdict)
    )

    with patch("benchmark.longmemeval.evaluate.AsyncOpenAI", return_value=mock_client):
        result = await judge_answer(
            question="What is Alice's favourite colour?",
            generated_answer="Alice's favourite colour is red.",
            gold_answer="blue",
            category="single-session-user",
            api_key="test-openai-key",
        )

    assert result["correct"] is False
    assert "blue" in result["reasoning"]


@pytest.mark.asyncio
async def test_judge_answer_temporal_reasoning():
    """Temporal reasoning category should use the temporal-specific prompt."""
    verdict = "yes\nOff-by-one date is acceptable."

    mock_client = MagicMock()
    mock_client.close = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(
        return_value=_make_openai_response(verdict)
    )

    with patch("benchmark.longmemeval.evaluate.AsyncOpenAI", return_value=mock_client):
        result = await judge_answer(
            question="When did Alice join?",
            generated_answer="Alice joined on January 2nd.",
            gold_answer="January 1st",
            category="temporal-reasoning",
            api_key="test-key",
        )

    assert result["correct"] is True
    # Verify the prompt used contained temporal-specific language
    call_args = mock_client.chat.completions.create.call_args
    prompt_text = call_args.kwargs["messages"][0]["content"]
    assert "Off-by-one" in prompt_text


@pytest.mark.asyncio
async def test_judge_answer_abstention():
    """Abstention category should use the abstention-specific prompt."""
    verdict = "yes\nThe system correctly refused."

    mock_client = MagicMock()
    mock_client.close = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(
        return_value=_make_openai_response(verdict)
    )

    with patch("benchmark.longmemeval.evaluate.AsyncOpenAI", return_value=mock_client):
        result = await judge_answer(
            question="What is Alice's SSN?",
            generated_answer="I don't know.",
            gold_answer="I don't know",
            category="abstention",
            api_key="test-key",
        )

    assert result["correct"] is True
    call_args = mock_client.chat.completions.create.call_args
    prompt_text = call_args.kwargs["messages"][0]["content"]
    assert "abstained" in prompt_text or "refusal" in prompt_text or "correctly abstained" in prompt_text


# ---------------------------------------------------------------------------
# score_results
# ---------------------------------------------------------------------------


def test_score_results_basic():
    results = [
        {"question_id": "q1", "category": "single-session-user", "correct": True},
        {"question_id": "q2", "category": "single-session-user", "correct": False},
        {"question_id": "q3", "category": "temporal-reasoning", "correct": True},
        {"question_id": "q4", "category": "temporal-reasoning", "correct": True},
    ]
    scores = score_results(results)

    assert scores["overall"] == pytest.approx(0.75)  # 3/4
    assert scores["by_category"]["single-session-user"]["score"] == pytest.approx(0.5)
    assert scores["by_category"]["single-session-user"]["total"] == 2
    assert scores["by_category"]["single-session-user"]["correct"] == 1
    assert scores["by_category"]["temporal-reasoning"]["score"] == pytest.approx(1.0)
    assert scores["by_category"]["temporal-reasoning"]["total"] == 2
    assert scores["by_category"]["temporal-reasoning"]["correct"] == 2


def test_score_results_all_correct():
    results = [
        {"question_id": "q1", "category": "abstention", "correct": True},
        {"question_id": "q2", "category": "abstention", "correct": True},
    ]
    scores = score_results(results)
    assert scores["overall"] == pytest.approx(1.0)
    assert scores["by_category"]["abstention"]["score"] == pytest.approx(1.0)


def test_score_results_all_incorrect():
    results = [
        {"question_id": "q1", "category": "knowledge-update", "correct": False},
        {"question_id": "q2", "category": "knowledge-update", "correct": False},
    ]
    scores = score_results(results)
    assert scores["overall"] == pytest.approx(0.0)
    assert scores["by_category"]["knowledge-update"]["score"] == pytest.approx(0.0)


def test_score_results_empty():
    scores = score_results([])
    assert scores["overall"] == 0.0
    assert scores["by_category"] == {}


def test_score_results_multiple_categories():
    categories = [
        "single-session-user",
        "single-session-assistant",
        "temporal-reasoning",
        "knowledge-update",
        "abstention",
    ]
    results = []
    for i, cat in enumerate(categories):
        results.append({"question_id": f"q{i}", "category": cat, "correct": i % 2 == 0})

    scores = score_results(results)
    # 3 correct out of 5 (indices 0, 2, 4)
    assert scores["overall"] == pytest.approx(3 / 5)
    assert set(scores["by_category"].keys()) == set(categories)


# ---------------------------------------------------------------------------
# evaluate_question (integration-style with mocks)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_evaluate_question():
    thoughts = [{"content": "The capital of France is Paris.", "created_at": "2024-01-01"}]

    reader_response = {
        "choices": [{"message": {"content": "The capital is Paris."}}]
    }
    judge_verdict = "yes\nCorrect answer."

    mock_client = MagicMock()
    mock_client.close = AsyncMock()
    mock_client.chat.completions.create = AsyncMock(
        return_value=_make_openai_response(judge_verdict)
    )

    with aioresponses() as mocked:
        mocked.post(
            "https://openrouter.ai/api/v1/chat/completions",
            payload=reader_response,
            status=200,
        )
        with patch("benchmark.longmemeval.evaluate.AsyncOpenAI", return_value=mock_client):
            result = await evaluate_question(
                question_id="q_test",
                question="What is the capital of France?",
                gold_answer="Paris",
                category="single-session-user",
                thoughts=thoughts,
                openrouter_key="openrouter-key",
                openai_key="openai-key",
            )

    assert result["question_id"] == "q_test"
    assert result["category"] == "single-session-user"
    assert result["generated_answer"] == "The capital is Paris."
    assert result["correct"] is True
    assert "Correct" in result["reasoning"]
