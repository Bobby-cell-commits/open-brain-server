// dream-synthesis.ts: Automated insight synthesis (Dream Cycle Phase C).
// Identifies clusters via find_synthesis_candidates RPC, generates cross-cutting
// insight via LLM, validates with separated probe QA, inserts as source='dream'.

import { supabaseAdmin } from "./supabase-client.ts";
import { chatCompletion, generateEmbedding } from "./openrouter.ts";
import type { DreamSynthesisResult } from "./types.ts";

const DEFAULT_MAX_CLUSTERS = 5;
const COVERAGE_THRESHOLD = 0.70;
const CONTENT_TRUNCATE = 2000;

// Toggle for shadow scoring measurement (first 4 weeks)
const SHADOW_SCORING_ENABLED = true;

// --- Prompts ---

const SYNTHESIS_PROMPT = `You are a knowledge synthesis engine for a personal knowledge base about AI, ML, and software engineering.

Given a cluster of related thoughts, generate a synthesis that:
1. Identifies the CORE INSIGHT that connects these thoughts — what do they collectively reveal that no single thought says alone?
2. Notes any TENSIONS or CONTRADICTIONS between thoughts
3. Is written as a standalone insight (someone reading only this synthesis should understand the key takeaway)
4. Include specific details (names, numbers, dates) from sources when they support the insight

DO NOT simply summarize each thought. The synthesis must add cross-cutting analytical value.
DO NOT make claims not supported by the source thoughts.

Return JSON: { "synthesis": "2-4 paragraphs, 150-300 words of insight text", "gap": "one sentence identifying what question this cluster does NOT answer" }`;

const PROBE_GENERATION_PROMPT = `You are a factual coverage evaluator for a knowledge base.

Given a set of source thoughts, generate 3-5 factual questions that an informed reader should be able to answer from the content.

Focus on specific claims, numbers, names, and relationships — not vague thematic questions.

Return JSON: { "probes": ["question1", "question2", ...] }`;

const PROBE_EVALUATION_PROMPT = `You are a factual coverage evaluator for a knowledge base.

Given a synthesis and a set of probe questions, determine whether the synthesis adequately answers each question.

Return JSON: {
  "evaluations": [
    {"question": "...", "answered": true/false, "evidence": "quote or null"}
  ],
  "coverage": 0.0-1.0,
  "pass": true/false
}

Coverage = questions answered / total questions.
Coverage threshold: 0.70. Set pass=true if coverage >= 0.70.`;

const COMBINED_PROBE_PROMPT = `You are a factual coverage evaluator for a knowledge base.

Given source thoughts and a synthesis, evaluate coverage:

1. Generate 3-5 factual questions from the sources that an informed reader should be able to answer.
2. For each question, determine if the synthesis answers it adequately.

Return JSON: {
  "probes": [{"question": "...", "answered": true/false}],
  "coverage": 0.0-1.0,
  "pass": true/false
}

Coverage = questions answered / total questions.
Coverage threshold: 0.70. Set pass=true if coverage >= 0.70.`;

// --- Interfaces ---

interface SynthesisCandidate {
  component_id: string;
  member_ids: string[];
  cluster_size: number;
  newest_thought_at: string;
  dominant_theme: string;
}

interface SourceThought {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  source: string;
}

interface ProbeResult {
  coverage: number;
  pass: boolean;
}

// --- LLM Calls ---

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function generateSynthesis(sources: SourceThought[]): Promise<{ text: string } | { error: string }> {
  try {
    const numbered = sources
      .map((s, i) => `${i + 1}. ${s.content.slice(0, CONTENT_TRUNCATE)}`)
      .join("\n\n");
    const response = await chatCompletion(SYNTHESIS_PROMPT, numbered);
    const parsed = JSON.parse(response);
    const text = parsed.synthesis ?? "";
    const gap = parsed.gap ?? "";
    const result = gap ? `${text}\n\nGap: ${gap}` : text;
    if (!result || result.length < 20) return { error: `too short (${result.length} chars)` };
    return { text: result };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

async function generateProbes(sources: SourceThought[]): Promise<{ probes: string[] } | { error: string }> {
  try {
    const numbered = sources
      .map((s, i) => `${i + 1}. ${s.content.slice(0, CONTENT_TRUNCATE)}`)
      .join("\n\n");
    const response = await chatCompletion(PROBE_GENERATION_PROMPT, numbered);
    const parsed = JSON.parse(response);
    if (!Array.isArray(parsed.probes) || parsed.probes.length === 0) {
      return { error: "no probes in response" };
    }
    return { probes: parsed.probes };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

async function evaluateProbes(synthesis: string, probes: string[]): Promise<{ result: ProbeResult } | { error: string }> {
  try {
    const message = `Synthesis:\n${synthesis}\n\nProbe questions:\n${probes.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
    const response = await chatCompletion(PROBE_EVALUATION_PROMPT, message);
    const parsed = JSON.parse(response);
    return {
      result: {
        coverage: typeof parsed.coverage === "number" ? parsed.coverage : 0,
        pass: parsed.pass === true,
      },
    };
  } catch (err) {
    return { error: errMsg(err) };
  }
}

async function combinedProbeEval(sources: SourceThought[], synthesis: string): Promise<ProbeResult | null> {
  try {
    const numbered = sources
      .map((s, i) => `${i + 1}. ${s.content.slice(0, CONTENT_TRUNCATE)}`)
      .join("\n\n");
    const message = `Sources:\n${numbered}\n\nSynthesis:\n${synthesis}`;
    const response = await chatCompletion(COMBINED_PROBE_PROMPT, message);
    const parsed = JSON.parse(response);
    return {
      coverage: typeof parsed.coverage === "number" ? parsed.coverage : 0,
      pass: parsed.pass === true,
    };
  } catch (err) {
    console.warn("dream-synthesis: shadow scoring failed (non-blocking):", err);
    return null;
  }
}

// --- Main ---

export async function dreamSynthesis(brainId: string, maxClusters = DEFAULT_MAX_CLUSTERS): Promise<DreamSynthesisResult> {
  const result: DreamSynthesisResult = {
    clusters_found: 0,
    clusters_synthesized: 0,
    clusters_skipped_low_coverage: 0,
    avg_coverage: 0,
    avg_cluster_size: 0,
    shadow_deltas: SHADOW_SCORING_ENABLED ? [] : null,
  };

  // Step 1: Find synthesis candidates
  const { data: candidates, error } = await supabaseAdmin.rpc("find_synthesis_candidates", {
    p_brain_id: brainId,
    p_limit: maxClusters,
  });

  if (error) {
    console.error("dream-synthesis: find_synthesis_candidates failed:", error);
    result.shadow_deltas = null;
    return result;
  }
  if (!candidates || candidates.length === 0) {
    result.shadow_deltas = null;
    return result;
  }

  result.clusters_found = candidates.length;

  let totalCoverage = 0;
  let totalClusterSize = 0;
  const shadowPromises: Promise<void>[] = [];

  // Step 2: Process each cluster
  for (const candidate of candidates as SynthesisCandidate[]) {
    try {
      // Fetch source thought contents
      const { data: sources, error: fetchErr } = await supabaseAdmin
        .from("thoughts")
        .select("id, content, metadata, source")
        .in("id", candidate.member_ids);

      if (fetchErr || !sources || sources.length === 0) {
        console.error(`dream-synthesis: failed to fetch sources for cluster ${candidate.component_id}:`, fetchErr);
        continue;
      }

      const sourceThoughts = sources as SourceThought[];

      // Call 1: Generate synthesis
      const synthResult = await generateSynthesis(sourceThoughts);
      if ("error" in synthResult) {
        console.warn(`dream-synthesis: skipping cluster ${candidate.component_id} — synthesis failed: ${synthResult.error}`);
        continue;
      }
      const synthesis = synthResult.text;

      // Call 2: Generate probes (sources only — no access to synthesis)
      const probeResult = await generateProbes(sourceThoughts);
      if ("error" in probeResult) {
        console.warn(`dream-synthesis: skipping cluster ${candidate.component_id} — probes failed: ${probeResult.error}`);
        continue;
      }
      const probes = probeResult.probes;

      // Call 3: Evaluate probes (synthesis + questions only — no access to sources)
      const evalResult = await evaluateProbes(synthesis, probes);
      if ("error" in evalResult) {
        console.warn(`dream-synthesis: skipping cluster ${candidate.component_id} — evaluation failed: ${evalResult.error}`);
        continue;
      }
      const evaluation = evalResult.result;

      // Shadow scoring: fire-and-forget, collected after loop (first 4 weeks)
      if (SHADOW_SCORING_ENABLED && result.shadow_deltas) {
        const deltas = result.shadow_deltas;
        const evalCoverage = evaluation.coverage;
        shadowPromises.push(
          combinedProbeEval(sourceThoughts, synthesis).then((combined) => {
            if (combined) deltas.push(combined.coverage - evalCoverage);
          }).catch(() => {}),
        );
      }

      totalCoverage += evaluation.coverage;
      totalClusterSize += candidate.cluster_size;

      // Decision: pass or skip
      if (!evaluation.pass || evaluation.coverage < COVERAGE_THRESHOLD) {
        result.clusters_skipped_low_coverage++;
        console.log(`dream-synthesis: skipped cluster ${candidate.component_id} (coverage: ${evaluation.coverage.toFixed(2)}, size: ${candidate.cluster_size})`);
        continue;
      }

      // Embed the synthesis
      const embedding = await generateEmbedding(synthesis);

      // Compute metadata
      const qualities = sourceThoughts
        .map((s) => typeof s.metadata?.quality === "number" ? s.metadata.quality : 0.5)
        .filter((q): q is number => q !== null);
      const avgQuality = qualities.length > 0
        ? qualities.reduce((a, b) => a + b, 0) / qualities.length
        : 0.5;

      const today = new Date().toISOString().slice(0, 10);
      const sourceEventId = `synthesis-${candidate.component_id}-${today}`;

      // Insert synthesis thought
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from("thoughts")
        .insert({
          brain_id: brainId,
          content: synthesis,
          embedding: JSON.stringify(embedding),
          source: "dream",
          source_event_id: sourceEventId,
          metadata: {
            type: "synthesis",
            theme: candidate.dominant_theme ?? "personal",
            quality: Math.round(avgQuality * 100) / 100,
            evidence_ids: candidate.member_ids,
            coverage_score: Math.round(evaluation.coverage * 100) / 100,
            cluster_size: candidate.cluster_size,
          },
        })
        .select("id, created_at")
        .single();

      if (insertErr || !inserted) {
        // Duplicate source_event_id = idempotency protection
        if (insertErr?.code === "23505") {
          console.log(`dream-synthesis: skipped cluster ${candidate.component_id} — already synthesized today`);
        } else {
          console.error(`dream-synthesis: insert failed for cluster ${candidate.component_id}:`, insertErr);
        }
        continue;
      }

      // Create 'synthesizes' connections to each source thought
      const connectionRows = candidate.member_ids.map((memberId: string) => ({
        brain_id: brainId,
        source_thought_id: inserted.id,
        target_thought_id: memberId,
        similarity: 1.0,  // Programmatic link, not cosine similarity
        link_type: "synthesizes",
        metadata: { reason: "Dream Phase C synthesis" },
      }));

      const { error: connErr } = await supabaseAdmin
        .from("thought_connections")
        .insert(connectionRows);

      if (connErr) {
        console.error(`dream-synthesis: connection insert failed for ${inserted.id}:`, connErr);
        // Non-fatal — thought is inserted, connections are best-effort
      }

      result.clusters_synthesized++;
      console.log(`dream-synthesis: synthesized cluster ${candidate.component_id} (coverage: ${evaluation.coverage.toFixed(2)}, size: ${candidate.cluster_size}, thought: ${inserted.id})`);

    } catch (err) {
      console.error(`dream-synthesis: unexpected error for cluster ${candidate.component_id}:`, err);
    }
  }

  // Settle shadow scoring promises before computing result
  if (shadowPromises.length > 0) {
    await Promise.allSettled(shadowPromises);
  }

  // Compute averages
  const processed = result.clusters_synthesized + result.clusters_skipped_low_coverage;
  result.avg_coverage = processed > 0 ? Math.round((totalCoverage / processed) * 100) / 100 : 0;
  result.avg_cluster_size = processed > 0 ? Math.round((totalClusterSize / processed) * 10) / 10 : 0;

  // Clean up shadow_deltas if empty
  if (result.shadow_deltas && result.shadow_deltas.length === 0) {
    result.shadow_deltas = null;
  }

  return result;
}
