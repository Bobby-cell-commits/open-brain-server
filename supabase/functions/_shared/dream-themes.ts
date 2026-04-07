// dream-themes.ts: Weekly theme tracking batch (Dream Cycle Phase B).
// Derives theme_thoughts from JSONB metadata, computes velocity,
// detects lifecycle transitions, updates centroids, takes snapshots.
// Pure SQL computation — no LLM calls.

import { supabaseAdmin } from "./supabase-client.ts";
import type { DreamThemesResult } from "./types.ts";

// Velocity smoothing: 30% new data, 70% previous
const VELOCITY_ALPHA = 0.3;

// Lifecycle thresholds (thoughts per week)
const EMERGING_VELOCITY = 8;
const ACTIVE_FLOOR = 2;
const MATURE_WEEKS = 8;
const DECLINING_WEEKS = 2;
const DORMANT_WEEKS = 4;

// Centroid update: 30% batch mean, 70% existing
const CENTROID_NEW_WEIGHT = 0.3;
const CENTROID_OLD_WEIGHT = 0.7;

interface ThemeRow {
  id: string;
  name: string;
  velocity: number;
  lifecycle_state: string;
  thought_count: number;
}

interface SnapshotRow {
  theme_id: string;
  lifecycle_state: string;
  velocity: number;
}

/**
 * Get the latest snapshot date across all themes for this brain.
 * Returns null if no snapshots exist.
 */
async function getLastSnapshotDate(brainId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("theme_snapshots")
    .select("snapshot_date")
    .in(
      "theme_id",
      (await supabaseAdmin.from("themes").select("id").eq("brain_id", brainId)).data?.map(
        (t: { id: string }) => t.id,
      ) ?? [],
    )
    .order("snapshot_date", { ascending: false })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0].snapshot_date;
}

/**
 * Get all themes for a brain.
 */
async function getThemes(brainId: string): Promise<ThemeRow[]> {
  const { data, error } = await supabaseAdmin
    .from("themes")
    .select("id, name, velocity, lifecycle_state, thought_count")
    .eq("brain_id", brainId);

  if (error) throw new Error(`Failed to fetch themes: ${error.message}`);
  return data ?? [];
}

/**
 * Populate theme_thoughts for new thoughts since last snapshot.
 * Returns count of new assignments.
 */
async function populateJunction(brainId: string, sinceDate: string | null): Promise<number> {
  // Find thoughts that have a theme in metadata but no theme_thoughts row
  const { data, error } = await supabaseAdmin.rpc("populate_theme_thoughts", {
    p_brain_id: brainId,
    p_since_date: sinceDate,
  });
  if (error) throw new Error(`Failed to populate junction: ${error.message}`);
  return (data as number) ?? 0;
}

/**
 * Count new thoughts per theme since a date.
 */
async function countNewThoughts(
  brainId: string,
  sinceDate: string | null,
): Promise<Record<string, number>> {
  const { data, error } = await supabaseAdmin.rpc("count_new_theme_thoughts", {
    p_brain_id: brainId,
    p_since_date: sinceDate,
  });
  if (error) throw new Error(`Failed to count new thoughts: ${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as Array<{ theme_name: string; cnt: number }>) {
    counts[row.theme_name] = row.cnt;
  }
  return counts;
}

/**
 * Get recent snapshot history for lifecycle transition detection.
 * Returns the last N snapshots per theme.
 */
async function getRecentSnapshots(
  themeId: string,
  limit: number,
): Promise<SnapshotRow[]> {
  const { data, error } = await supabaseAdmin
    .from("theme_snapshots")
    .select("theme_id, lifecycle_state, velocity")
    .eq("theme_id", themeId)
    .order("snapshot_date", { ascending: false })
    .limit(limit);

  if (error) return [];
  return data ?? [];
}

/**
 * Detect lifecycle transition for a theme based on velocity and history.
 */
async function detectTransition(
  theme: ThemeRow,
  newVelocity: number,
  allVelocities: number[],
): Promise<string | null> {
  const current = theme.lifecycle_state;
  const medianVelocity = allVelocities.length > 0
    ? allVelocities.sort((a, b) => a - b)[Math.floor(allVelocities.length / 2)]
    : 0;

  // Check for emerging: high velocity AND > 2x median
  if (
    current === "active" &&
    newVelocity > EMERGING_VELOCITY &&
    newVelocity > 2 * medianVelocity
  ) {
    const snapshots = await getRecentSnapshots(theme.id, 2);
    const sustained = snapshots.length >= 1 &&
      snapshots.every((s) => s.velocity > EMERGING_VELOCITY);
    if (sustained) return "emerging";
  }

  // Emerging → active: dropped below threshold
  if (
    current === "emerging" &&
    (newVelocity <= EMERGING_VELOCITY || newVelocity <= 2 * medianVelocity)
  ) {
    return "active";
  }

  // Active → mature: sustained 2-8 for MATURE_WEEKS consecutive
  if (current === "active" && newVelocity >= ACTIVE_FLOOR && newVelocity <= EMERGING_VELOCITY) {
    const snapshots = await getRecentSnapshots(theme.id, MATURE_WEEKS);
    if (
      snapshots.length >= MATURE_WEEKS - 1 &&
      snapshots.every(
        (s) => s.velocity >= ACTIVE_FLOOR && s.velocity <= EMERGING_VELOCITY,
      )
    ) {
      return "mature";
    }
  }

  // Active/mature → declining: velocity < ACTIVE_FLOOR for DECLINING_WEEKS
  if (
    (current === "active" || current === "mature") &&
    newVelocity < ACTIVE_FLOOR
  ) {
    const snapshots = await getRecentSnapshots(theme.id, DECLINING_WEEKS);
    const sustained = snapshots.length >= DECLINING_WEEKS - 1 &&
      snapshots.every((s) => s.velocity < ACTIVE_FLOOR);
    if (sustained) return "declining";
  }

  // Declining → dormant: velocity = 0 for DORMANT_WEEKS
  if (current === "declining" && newVelocity === 0) {
    const snapshots = await getRecentSnapshots(theme.id, DORMANT_WEEKS);
    const sustained = snapshots.length >= DORMANT_WEEKS - 1 &&
      snapshots.every((s) => s.velocity === 0);
    if (sustained) return "dormant";
  }

  // Recovery: declining/dormant → active
  if (
    (current === "declining" || current === "dormant") &&
    newVelocity >= ACTIVE_FLOOR
  ) {
    return "active";
  }

  return null; // No transition
}

/**
 * Update centroid for a theme using weighted average with new thoughts.
 * Returns centroid drift (cosine distance) or null if skipped.
 */
async function updateCentroid(
  themeId: string,
  sinceDate: string | null,
): Promise<number | null> {
  // Compute drift and update in one RPC call
  const { data, error } = await supabaseAdmin.rpc("update_theme_centroid", {
    p_theme_id: themeId,
    p_since_date: sinceDate,
    p_old_weight: CENTROID_OLD_WEIGHT,
    p_new_weight: CENTROID_NEW_WEIGHT,
  });

  if (error) {
    console.error(`Centroid update failed for ${themeId}: ${error.message}`);
    return null;
  }

  return (data as number) ?? null;
}

/**
 * Main entry point: run the weekly theme tracking batch.
 */
export async function dreamThemes(brainId: string): Promise<DreamThemesResult> {
  const themes = await getThemes(brainId);
  if (themes.length === 0) {
    return { themes_processed: 0, thoughts_assigned: 0, transitions: [], snapshot_date: "" };
  }

  const lastSnapshotDate = await getLastSnapshotDate(brainId);
  const today = new Date().toISOString().slice(0, 10);

  // Step 1: Populate junction for new thoughts
  const thoughtsAssigned = await populateJunction(brainId, lastSnapshotDate);

  // Step 2: Update thought_count per theme
  for (const theme of themes) {
    const { count, error } = await supabaseAdmin
      .from("theme_thoughts")
      .select("*", { count: "exact", head: true })
      .eq("theme_id", theme.id);
    if (!error && count != null) {
      theme.thought_count = count;
      await supabaseAdmin
        .from("themes")
        .update({ thought_count: count })
        .eq("id", theme.id);
    }
  }

  // Step 3: Compute velocity
  const newCounts = await countNewThoughts(brainId, lastSnapshotDate);
  const velocities: Record<string, number> = {};
  for (const theme of themes) {
    const periodCount = newCounts[theme.name] ?? 0;
    const newVelocity = lastSnapshotDate === null
      ? periodCount // First run: raw count
      : VELOCITY_ALPHA * periodCount + (1 - VELOCITY_ALPHA) * theme.velocity;
    velocities[theme.name] = newVelocity;
  }

  // Step 4: Detect lifecycle transitions
  const allVelocities = Object.values(velocities);
  const transitions: Array<{ theme: string; from: string; to: string }> = [];

  for (const theme of themes) {
    const newVelocity = velocities[theme.name];
    const newState = await detectTransition(theme, newVelocity, allVelocities);
    if (newState) {
      transitions.push({ theme: theme.name, from: theme.lifecycle_state, to: newState });
      theme.lifecycle_state = newState;
    }
  }

  // Step 5-6: Update centroids and compute drift
  const drifts: Record<string, number | null> = {};
  for (const theme of themes) {
    const periodCount = newCounts[theme.name] ?? 0;
    if (periodCount > 0) {
      drifts[theme.name] = await updateCentroid(theme.id, lastSnapshotDate);
    } else {
      drifts[theme.name] = null;
    }
  }

  // Step 7: Insert snapshot rows
  for (const theme of themes) {
    const { error } = await supabaseAdmin.from("theme_snapshots").upsert(
      {
        theme_id: theme.id,
        snapshot_date: today,
        thought_count: theme.thought_count,
        new_thoughts: newCounts[theme.name] ?? 0,
        avg_quality: null, // Populated by RPC below
        avg_salience: null,
        centroid_drift: drifts[theme.name] ?? 0,
        lifecycle_state: theme.lifecycle_state,
        velocity: velocities[theme.name],
      },
      { onConflict: "theme_id,snapshot_date" },
    );
    if (error) console.error(`Snapshot insert failed for ${theme.name}: ${error.message}`);
  }

  // Populate avg_quality and avg_salience via RPC (more efficient than per-theme queries)
  await supabaseAdmin.rpc("fill_snapshot_averages", { p_snapshot_date: today });

  // Step 8: Update themes table (velocity, lifecycle, updated_at)
  for (const theme of themes) {
    await supabaseAdmin
      .from("themes")
      .update({
        velocity: velocities[theme.name],
        lifecycle_state: theme.lifecycle_state,
        updated_at: new Date().toISOString(),
      })
      .eq("id", theme.id);
  }

  // Log transitions
  for (const t of transitions) {
    console.log(`Theme lifecycle: ${t.theme} ${t.from} → ${t.to}`);
  }

  return {
    themes_processed: themes.length,
    thoughts_assigned: thoughtsAssigned,
    transitions,
    snapshot_date: today,
  };
}
