"""Load and transform LongMemEval-S dataset into ThoughtRecords.

Each conversation session becomes one thought, grouped by question_id.
"""

from pathlib import Path

from benchmark.bulk_import import ThoughtRecord
from benchmark.config import hf_token

MAX_CONTENT_LENGTH = 10000  # OB's capture limit
DATA_DIR = Path(__file__).parent.parent / "data"


def _load_raw_dataset() -> list[dict]:
    """Load LongMemEval-S from HuggingFace datasets library."""
    from datasets import load_dataset

    ds = load_dataset(
        "xiaowu0162/longmemeval-cleaned",
        data_files="longmemeval_s_cleaned.json",
        split="train",
        cache_dir=str(DATA_DIR),
        token=hf_token(),
    )
    return list(ds)


def session_to_content(session: list[dict], session_index: int, date: str) -> str:
    """Convert a conversation session to thought content.

    Format: [Session N, DATE]\nRole: message\n...
    Truncated to MAX_CONTENT_LENGTH.
    """
    header = f"[Session {session_index}, {date}]"
    lines = [header]
    for turn in session:
        role = turn["role"].capitalize()
        lines.append(f"{role}: {turn['content']}")

    content = "\n".join(lines)
    if len(content) > MAX_CONTENT_LENGTH:
        content = content[:MAX_CONTENT_LENGTH - 3] + "..."
    return content


def load_dataset_to_thoughts(
    question_ids: list[str] | None = None,
) -> dict[str, list[ThoughtRecord]]:
    """Load LongMemEval-S and transform to ThoughtRecords grouped by question.

    Args:
        question_ids: optional subset of question IDs to load

    Returns:
        dict mapping question_id -> list of ThoughtRecords (one per session)
    """
    raw = _load_raw_dataset()

    result: dict[str, list[ThoughtRecord]] = {}
    for question in raw:
        qid = question["question_id"]
        if question_ids and qid not in question_ids:
            continue

        sessions = question["haystack_sessions"]
        dates = question["haystack_dates"]
        thoughts = []
        for i, (session, date) in enumerate(zip(sessions, dates)):
            content = session_to_content(session, session_index=i, date=date)
            thoughts.append(ThoughtRecord(
                content=content,
                source_event_id=f"{qid}_{i}",
            ))
        result[qid] = thoughts

    return result
