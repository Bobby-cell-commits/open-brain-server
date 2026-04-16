"""Compute UMAP 2D projections and write back to Supabase.

Fetches 1536-dim embeddings from the thoughts table, reduces to 2D via UMAP,
and writes umap_x/umap_y coordinates back. Supports incremental mode: if most
thoughts already have coordinates, only projects new ones via .transform().

Usage:
    python -m pipeline.umap_projection           # auto-detect mode
    python -m pipeline.umap_projection --full     # force full refit
"""

import json
import subprocess
import os
import argparse
import numpy as np

BRAIN_ID = os.getenv("BRAIN_ID", "00000000-0000-4000-a000-000000000001")
BATCH_SIZE = 300
CACHE_REDUCER = "/tmp/ob-umap-reducer.pkl"
OPENBRAIN_DIR = os.path.join(os.path.dirname(__file__), "..", "openbrain")

# Threshold: if this fraction of thoughts already have coords, use incremental
INCREMENTAL_THRESHOLD = 0.80


def query_supabase(sql: str) -> list[dict]:
    """Run SQL via supabase CLI, return parsed rows."""
    result = subprocess.run(
        ["supabase", "db", "query", "--linked", sql],
        capture_output=True, text=True,
        cwd=OPENBRAIN_DIR,
    )
    if result.returncode != 0:
        raise RuntimeError(f"supabase query failed: {result.stderr}")
    raw = result.stdout
    start = raw.index("{")
    data = json.loads(raw[start:])
    return data["rows"]


def execute_sql(sql: str) -> None:
    """Run SQL statement (no result expected)."""
    result = subprocess.run(
        ["supabase", "db", "query", "--linked", sql],
        capture_output=True, text=True,
        cwd=OPENBRAIN_DIR,
    )
    if result.returncode != 0:
        raise RuntimeError(f"supabase query failed: {result.stderr}")


def fetch_embeddings(only_missing: bool = False) -> tuple[list[dict], np.ndarray]:
    """Fetch embeddings in batches. Returns (metadata, embeddings_array)."""
    where = (
        f"brain_id = '{BRAIN_ID}' AND archived_at IS NULL AND embedding IS NOT NULL"
    )
    if only_missing:
        where += " AND umap_x IS NULL"

    rows = query_supabase(f"SELECT count(*) as n FROM thoughts WHERE {where}")
    total = int(rows[0]["n"])
    if total == 0:
        return [], np.array([], dtype=np.float32)

    print(f"Fetching {total} embeddings in batches of {BATCH_SIZE}...")
    all_embeddings = []
    all_metadata = []
    offset = 0

    while offset < total:
        print(f"  Batch {offset}/{total}...", end=" ", flush=True)
        batch = query_supabase(f"""
            SELECT id, embedding::text as emb
            FROM thoughts
            WHERE {where}
            ORDER BY id
            LIMIT {BATCH_SIZE} OFFSET {offset}
        """)
        print(f"{len(batch)} rows")

        for row in batch:
            emb = json.loads(row["emb"])
            all_embeddings.append(emb)
            all_metadata.append({"id": row["id"]})

        offset += BATCH_SIZE
        if len(batch) < BATCH_SIZE:
            break

    embeddings = np.array(all_embeddings, dtype=np.float32)
    print(f"Fetched {len(all_metadata)} embeddings, shape: {embeddings.shape}")
    return all_metadata, embeddings


def write_coordinates(metadata: list[dict], coords: np.ndarray) -> None:
    """Write umap_x/umap_y back to thoughts table in batches."""
    print(f"Writing {len(metadata)} coordinates back to DB...")
    batch_size = 100
    for i in range(0, len(metadata), batch_size):
        batch = metadata[i:i + batch_size]
        batch_coords = coords[i:i + batch_size]
        cases_x = []
        cases_y = []
        ids = []
        for j, meta in enumerate(batch):
            x = round(float(batch_coords[j, 0]), 6)
            y = round(float(batch_coords[j, 1]), 6)
            cases_x.append(f"WHEN '{meta['id']}' THEN {x}")
            cases_y.append(f"WHEN '{meta['id']}' THEN {y}")
            ids.append(f"'{meta['id']}'")

        sql = f"""
            UPDATE thoughts SET
                umap_x = CASE id::text {' '.join(cases_x)} END,
                umap_y = CASE id::text {' '.join(cases_y)} END
            WHERE id IN ({', '.join(ids)})
        """
        execute_sql(sql)
        print(f"  Written {min(i + batch_size, len(metadata))}/{len(metadata)}")

    print("Done writing coordinates.")


def main():
    parser = argparse.ArgumentParser(description="Compute UMAP projections for Open Brain")
    parser.add_argument("--full", action="store_true", help="Force full refit (ignore existing coords)")
    args = parser.parse_args()

    import umap as umap_lib
    # pickle is used here to cache the fitted UMAP reducer for incremental
    # projections. This is a local-only cache of our own model, not untrusted data.
    import pickle  # noqa: S403

    # Check how many thoughts already have coordinates
    rows = query_supabase(f"""
        SELECT
            count(*) FILTER (WHERE umap_x IS NOT NULL) as has_coords,
            count(*) as total
        FROM thoughts
        WHERE brain_id = '{BRAIN_ID}' AND archived_at IS NULL AND embedding IS NOT NULL
    """)
    has_coords = int(rows[0]["has_coords"])
    total = int(rows[0]["total"])
    coverage = has_coords / total if total > 0 else 0

    print(f"UMAP coverage: {has_coords}/{total} ({coverage:.0%})")

    if not args.full and coverage >= INCREMENTAL_THRESHOLD and os.path.exists(CACHE_REDUCER):
        # Incremental: transform new points only
        missing = total - has_coords
        if missing == 0:
            print("All thoughts already have UMAP coordinates. Nothing to do.")
            return

        print(f"Incremental mode: projecting {missing} new thoughts...")
        with open(CACHE_REDUCER, "rb") as f:
            reducer = pickle.load(f)  # noqa: S301

        meta, embeddings = fetch_embeddings(only_missing=True)
        if len(meta) == 0:
            print("No new embeddings to project.")
            return

        coords = reducer.transform(embeddings)
        write_coordinates(meta, coords)
    else:
        # Full refit
        print("Full refit mode: computing UMAP for all thoughts...")
        meta, embeddings = fetch_embeddings(only_missing=False)
        if len(meta) == 0:
            print("No embeddings found.")
            return

        print(f"Running UMAP on {embeddings.shape[0]} x {embeddings.shape[1]} matrix...")
        reducer = umap_lib.UMAP(
            n_components=2,
            n_neighbors=30,
            min_dist=0.1,
            metric="cosine",
            random_state=42,
            verbose=True,
        )
        coords = reducer.fit_transform(embeddings)
        print(f"UMAP complete. Output shape: {coords.shape}")

        # Cache reducer for future incremental runs
        with open(CACHE_REDUCER, "wb") as f:
            pickle.dump(reducer, f)
        print(f"Reducer cached to {CACHE_REDUCER}")

        write_coordinates(meta, coords)

    print("UMAP projection complete.")


if __name__ == "__main__":
    main()
