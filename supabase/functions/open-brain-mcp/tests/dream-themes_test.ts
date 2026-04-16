// dream-themes: Tests for weekly theme tracking batch (Dream Cycle Phase B).

import { assertEquals } from "jsr:@std/assert";
import { mockChain, stubRpc, stubFrom, restore } from "./_helpers.ts";
import { supabaseAdmin } from "../../_shared/supabase-client.ts";
import { dreamThemes } from "../../_shared/dream-themes.ts";

const TEST_BRAIN_ID = "test-brain-00000000";

// --- Helpers ---

function makeTheme(name: string, velocity = 3.0, lifecycle = "active", count = 50): any {
  return { id: `theme-${name}`, name, velocity, lifecycle_state: lifecycle, thought_count: count };
}

// --- Tests ---

Deno.test("returns empty result when no themes exist", async () => {
  stubFrom(supabaseAdmin, () => mockChain({ data: [], error: null }));
  try {
    const result = await dreamThemes(TEST_BRAIN_ID);
    assertEquals(result.themes_processed, 0);
    assertEquals(result.thoughts_assigned, 0);
    assertEquals(result.transitions.length, 0);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("populates junction and takes snapshot for themes", async () => {
  const themes = [makeTheme("ml-research"), makeTheme("developer-experience", 1.0, "active", 20)];
  let rpcCalls: Array<{ name: string; args: any }> = [];
  let fromCalls: Array<{ table: string }> = [];

  stubFrom(supabaseAdmin, (table: string) => {
    fromCalls.push({ table });
    if (table === "themes") return mockChain({ data: themes, error: null });
    if (table === "theme_snapshots") return mockChain({ data: [], error: null });
    if (table === "theme_thoughts") return mockChain({ count: 50, error: null });
    return mockChain({ data: null, error: null });
  });

  stubRpc(supabaseAdmin, (name: string, args: any) => {
    rpcCalls.push({ name, args });
    if (name === "populate_theme_thoughts") return mockChain({ data: 5, error: null });
    if (name === "count_new_theme_thoughts") {
      return mockChain({
        data: [
          { theme_name: "ml-research", cnt: 8 },
          { theme_name: "developer-experience", cnt: 2 },
        ],
        error: null,
      });
    }
    if (name === "update_theme_centroid") return mockChain({ data: 0.02, error: null });
    if (name === "fill_snapshot_averages") return mockChain({ data: null, error: null });
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamThemes(TEST_BRAIN_ID);
    assertEquals(result.themes_processed, 2);
    assertEquals(result.thoughts_assigned, 5);
    assertEquals(typeof result.snapshot_date, "string");

    // Verify populate was called
    const populateCall = rpcCalls.find((c) => c.name === "populate_theme_thoughts");
    assertEquals(populateCall?.args.p_brain_id, TEST_BRAIN_ID);

    // Verify centroid update was called (ml-research has 8 new thoughts)
    const centroidCalls = rpcCalls.filter((c) => c.name === "update_theme_centroid");
    assertEquals(centroidCalls.length, 2); // Both themes had new thoughts
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("skips centroid update when theme has zero new thoughts", async () => {
  const themes = [makeTheme("ml-research")];
  let centroidCalled = false;

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "themes") return mockChain({ data: themes, error: null });
    if (table === "theme_snapshots") return mockChain({ data: [], error: null });
    if (table === "theme_thoughts") return mockChain({ count: 50, error: null });
    return mockChain({ data: null, error: null });
  });

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "populate_theme_thoughts") return mockChain({ data: 0, error: null });
    if (name === "count_new_theme_thoughts") {
      return mockChain({ data: [{ theme_name: "ml-research", cnt: 0 }], error: null });
    }
    if (name === "update_theme_centroid") {
      centroidCalled = true;
      return mockChain({ data: null, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  try {
    await dreamThemes(TEST_BRAIN_ID);
    assertEquals(centroidCalled, false);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("velocity uses raw count on first run (no prior snapshots)", async () => {
  const themes = [makeTheme("ml-research", 0, "active", 0)];

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "themes") return mockChain({ data: themes, error: null });
    if (table === "theme_snapshots") return mockChain({ data: [], error: null });
    if (table === "theme_thoughts") return mockChain({ count: 10, error: null });
    return mockChain({ data: null, error: null });
  });

  let capturedSnapshot: any;
  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "theme_snapshots") {
      return {
        select: () => mockChain({ data: [], error: null }),
        upsert: (row: any) => {
          capturedSnapshot = row;
          return mockChain({ data: null, error: null });
        },
      };
    }
    if (table === "themes") {
      return {
        select: () => mockChain({ data: themes, error: null }),
        update: () => mockChain({ data: null, error: null }),
      };
    }
    if (table === "theme_thoughts") {
      return mockChain({ count: 10, error: null });
    }
    return mockChain({ data: null, error: null });
  });

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "populate_theme_thoughts") return mockChain({ data: 10, error: null });
    if (name === "count_new_theme_thoughts") {
      return mockChain({ data: [{ theme_name: "ml-research", cnt: 10 }], error: null });
    }
    if (name === "update_theme_centroid") return mockChain({ data: 0.01, error: null });
    return mockChain({ data: null, error: null });
  });

  try {
    await dreamThemes(TEST_BRAIN_ID);
    // First run: velocity = raw period count = 10 (not smoothed)
    assertEquals(capturedSnapshot?.velocity, 10);
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("detects declining transition when velocity drops below 2 for 2+ weeks", async () => {
  const themes = [makeTheme("infrastructure", 1.5, "active", 30)];

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "themes") return mockChain({ data: themes, error: null });
    if (table === "theme_snapshots") {
      return mockChain({
        data: [{ theme_id: "theme-infrastructure", lifecycle_state: "active", velocity: 1.0 }],
        error: null,
      });
    }
    if (table === "theme_thoughts") return mockChain({ count: 30, error: null });
    return mockChain({ data: null, error: null });
  });

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "populate_theme_thoughts") return mockChain({ data: 0, error: null });
    if (name === "count_new_theme_thoughts") {
      return mockChain({ data: [{ theme_name: "infrastructure", cnt: 1 }], error: null });
    }
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamThemes(TEST_BRAIN_ID);
    const transition = result.transitions.find((t) => t.theme === "infrastructure");
    assertEquals(transition?.from, "active");
    assertEquals(transition?.to, "declining");
  } finally {
    restore(supabaseAdmin);
  }
});

Deno.test("detects recovery from dormant to active", async () => {
  const themes = [makeTheme("security", 0, "dormant", 15)];

  stubFrom(supabaseAdmin, (table: string) => {
    if (table === "themes") return mockChain({ data: themes, error: null });
    if (table === "theme_snapshots") return mockChain({ data: [], error: null });
    if (table === "theme_thoughts") return mockChain({ count: 15, error: null });
    return mockChain({ data: null, error: null });
  });

  stubRpc(supabaseAdmin, (name: string) => {
    if (name === "populate_theme_thoughts") return mockChain({ data: 3, error: null });
    if (name === "count_new_theme_thoughts") {
      return mockChain({ data: [{ theme_name: "security", cnt: 3 }], error: null });
    }
    if (name === "update_theme_centroid") return mockChain({ data: 0.05, error: null });
    return mockChain({ data: null, error: null });
  });

  try {
    const result = await dreamThemes(TEST_BRAIN_ID);
    const transition = result.transitions.find((t) => t.theme === "security");
    assertEquals(transition?.from, "dormant");
    assertEquals(transition?.to, "active");
  } finally {
    restore(supabaseAdmin);
  }
});
