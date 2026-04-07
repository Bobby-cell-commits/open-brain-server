"""JSON-based state management for benchmark runs.

State file tracks provisioned brains, ingestion progress, and summary counts.
Double idempotency: state file is an optimization — the DB unique constraint
on (source, source_event_id) prevents duplicates even if state is lost.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class BenchmarkState:
    path: Path
    run_id: str
    phase: str = "initialized"
    brains: dict = field(default_factory=dict)
    ingestion: dict = field(default_factory=dict)
    summary: dict = field(default_factory=lambda: {
        "total_thoughts": 0,
        "completed": 0,
        "failed": 0,
        "merged": 0,
        "started_at": None,
        "last_updated": None,
    })

    def add_brain(self, question_id: str, brain_id: str, api_key: str) -> None:
        self.brains[question_id] = {
            "brain_id": brain_id,
            "api_key": api_key,
            "provisioned_at": datetime.now(timezone.utc).isoformat(),
        }

    def is_brain_provisioned(self, question_id: str) -> bool:
        return question_id in self.brains

    def init_brain_ingestion(self, question_id: str, total: int) -> None:
        if question_id not in self.ingestion:
            self.ingestion[question_id] = {
                "total": total,
                "completed": [],
                "failed": {},
                "merged": [],
            }
            self.summary["total_thoughts"] += total

    def _clear_prior_failure(self, question_id: str, event_id: str) -> None:
        """If event_id was previously recorded as failed, remove it and fix the counter."""
        failed = self.ingestion[question_id]["failed"]
        if event_id in failed:
            del failed[event_id]
            self.summary["failed"] -= 1

    def record_completed(self, question_id: str, event_id: str, thought_id: str) -> None:
        self._clear_prior_failure(question_id, event_id)
        self.ingestion[question_id]["completed"].append(event_id)
        self.summary["completed"] += 1
        self.summary["last_updated"] = datetime.now(timezone.utc).isoformat()

    def record_failed(self, question_id: str, event_id: str, error: str) -> None:
        self.ingestion[question_id]["failed"][event_id] = error
        self.summary["failed"] += 1
        self.summary["last_updated"] = datetime.now(timezone.utc).isoformat()

    def record_merged(self, question_id: str, event_id: str) -> None:
        self._clear_prior_failure(question_id, event_id)
        self.ingestion[question_id]["merged"].append(event_id)
        self.summary["merged"] += 1
        self.summary["last_updated"] = datetime.now(timezone.utc).isoformat()

    def is_done(self, question_id: str, event_id: str) -> bool:
        entry = self.ingestion.get(question_id, {})
        return (
            event_id in entry.get("completed", [])
            or event_id in entry.get("merged", [])
        )

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "run_id": self.run_id,
            "phase": self.phase,
            "brains": self.brains,
            "ingestion": self.ingestion,
            "summary": self.summary,
        }
        self.path.write_text(json.dumps(data, indent=2))

    @classmethod
    def load(cls, path: Path) -> "BenchmarkState | None":
        if not path.exists():
            return None
        data = json.loads(path.read_text())
        state = cls(
            path=path,
            run_id=data["run_id"],
            phase=data.get("phase", "initialized"),
        )
        state.brains = data.get("brains", {})
        state.ingestion = data.get("ingestion", {})
        state.summary = data.get("summary", state.summary)
        return state
