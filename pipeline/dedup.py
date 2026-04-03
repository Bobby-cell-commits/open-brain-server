"""JSON-file-based processed item tracker for deduplication."""

import json
import time
import tempfile
import os
from pipeline.config import DATA_DIR


class DedupTracker:
    """Tracks processed items to prevent re-processing."""

    def __init__(self, filename: str):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.path = DATA_DIR / filename
        self._data: dict[str, dict] = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                return {}
        return {}

    def _save(self):
        """Atomic write via temp file + rename."""
        tmp_fd, tmp_path = tempfile.mkstemp(
            dir=str(self.path.parent), suffix=".tmp"
        )
        try:
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2)
            os.replace(tmp_path, str(self.path))
        except Exception:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            raise

    def is_processed(self, item_id: str) -> bool:
        return item_id in self._data

    def mark_processed(self, item_id: str, source: str):
        self._data[item_id] = {
            "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": source,
        }
        self._save()

    def cleanup(self, max_age_days: int = 90):
        """Remove entries older than max_age_days."""
        cutoff = time.time() - (max_age_days * 86400)
        to_remove = []
        for item_id, info in self._data.items():
            try:
                ts = time.mktime(time.strptime(info["captured_at"], "%Y-%m-%dT%H:%M:%SZ"))
                if ts < cutoff:
                    to_remove.append(item_id)
            except (KeyError, ValueError):
                continue
        for item_id in to_remove:
            del self._data[item_id]
        if to_remove:
            self._save()
        return len(to_remove)

    @property
    def count(self) -> int:
        return len(self._data)
