// migration-guide: Pure logic — no Supabase calls, no mocking needed.

import { assertEquals } from "jsr:@std/assert";
import { createMockMcp } from "./_helpers.ts";
import { registerMigrationGuide } from "../tools/migration-guide.ts";
import * as z from "npm:zod@3";

const { mcp, tools } = createMockMcp();
registerMigrationGuide(mcp as any, z);
const handler = tools.get("migration_guide")!;

Deno.test("known platform returns platform-specific guide", async () => {
  const result = await handler({ platform: "notion" });
  const guide = JSON.parse(result.content[0].text);
  assertEquals(guide.platform, "notion");
  assertEquals(Array.isArray(guide.export_steps), true);
  assertEquals(guide.export_steps.length > 0, true);
  assertEquals(typeof guide.capture_template, "object");
});

Deno.test("unknown platform falls back to generic with custom name", async () => {
  const result = await handler({ platform: "roam" });
  const guide = JSON.parse(result.content[0].text);
  assertEquals(guide.platform, "roam");
  assertEquals(Array.isArray(guide.export_steps), true);
  assertEquals(guide.tips.length > 0, true);
});

Deno.test("platform name is normalized (case + whitespace)", async () => {
  const result = await handler({ platform: "  Obsidian  " });
  const guide = JSON.parse(result.content[0].text);
  assertEquals(guide.platform, "obsidian");
});

Deno.test("all known platforms return valid guides", async () => {
  const platforms = ["notion", "obsidian", "claude-web", "claude-code", "generic"];
  for (const platform of platforms) {
    const result = await handler({ platform });
    const guide = JSON.parse(result.content[0].text);
    assertEquals(guide.platform, platform);
    assertEquals(Array.isArray(guide.export_steps), true);
    assertEquals(typeof guide.estimated_effort, "string");
  }
});
