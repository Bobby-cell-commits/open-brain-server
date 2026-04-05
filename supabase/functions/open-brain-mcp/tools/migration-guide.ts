// migration_guide: Structured migration runbook for importing memories from another platform
// Returns AI-executable runbooks (not human docs) with actual tool call examples.

import type { McpServer } from "npm:mcp-lite";

type Z = typeof import("npm:zod@3");

// ---------------------------------------------------------------------------
// Platform-specific migration guides
// ---------------------------------------------------------------------------

interface MigrationGuide {
  platform: string;
  export_steps: string[];
  format_mapping: {
    source_unit: string;
    content_template: string;
    metadata_notes: string;
  };
  capture_template: {
    tool: string;
    arguments: { content: string };
  };
  tips: string[];
  estimated_effort: string;
}

function getGuides(): Record<string, MigrationGuide> {
  return {
    notion: {
      platform: "notion",
      export_steps: [
        "Open Notion and navigate to Settings > Workspace",
        "Click 'Export all workspace content' and select 'Markdown & CSV' format",
        "Download and unzip the exported archive",
        "Each .md file represents one page -- read each file's content",
        "For each page, call capture_thought with the page title + body as content",
      ],
      format_mapping: {
        source_unit: "One Notion page = one thought",
        content_template:
          "# {page_title}\n\n{page_body_markdown}",
        metadata_notes:
          "Notion tags/properties can be prepended to content for automatic extraction",
      },
      capture_template: {
        tool: "capture_thought",
        arguments: {
          content:
            "# Meeting Notes: Q1 Planning\n\nDiscussed roadmap priorities with @alice. Key decisions: focus on mobile-first, defer analytics to Q2. Action item: draft PRD by Friday.",
        },
      },
      tips: [
        "Export as Markdown (not HTML) for cleaner content",
        "Notion databases export as CSV -- convert rows to individual thoughts",
        "Nested pages are exported as separate files, which maps naturally to individual thoughts",
        "Process pages in chronological order if possible for better weekly review context",
      ],
      estimated_effort: "Small vault (<100 pages): ~10 minutes. Large vault (500+ pages): ~30 minutes with batching.",
    },

    obsidian: {
      platform: "obsidian",
      export_steps: [
        "Locate your Obsidian vault directory on disk (it's just a folder of .md files)",
        "List all .md files in the vault recursively",
        "For each .md file, read the file content",
        "Call capture_thought with filename (without .md) as title + file body as content",
        "Skip any files in .obsidian/ directory (config, not content)",
      ],
      format_mapping: {
        source_unit: "One .md file = one thought",
        content_template:
          "# {filename_without_extension}\n\n{file_body}",
        metadata_notes:
          "Obsidian frontmatter (YAML between ---) can be included in content for metadata extraction",
      },
      capture_template: {
        tool: "capture_thought",
        arguments: {
          content:
            "# Distributed Systems Notes\n\nCAP theorem: you can only guarantee two of Consistency, Availability, Partition tolerance. Most modern systems choose AP with eventual consistency.",
        },
      },
      tips: [
        "Include YAML frontmatter in the content -- the metadata extractor will pick up tags and topics",
        "Obsidian [[wikilinks]] will be preserved in content, providing useful context",
        "Daily notes can be batched or skipped depending on their value",
        "Attachments (images, PDFs) cannot be migrated -- only text content",
      ],
      estimated_effort: "Small vault (<200 notes): ~15 minutes. Large vault (1000+ notes): ~1 hour with batching.",
    },

    "claude-web": {
      platform: "claude-web",
      export_steps: [
        "Go to claude.ai and open Settings",
        "Navigate to the 'Memories' or 'Saved memories' section",
        "Copy all memories (select all text or use export if available)",
        "Split the copied text by memory boundaries (each memory is typically one paragraph or fact)",
        "For each memory, call capture_thought with the memory text as content",
      ],
      format_mapping: {
        source_unit: "One Claude memory = one thought",
        content_template: "{memory_text}",
        metadata_notes:
          "Claude memories are typically short factual statements -- they will be typed as 'note' or 'idea' by the extractor",
      },
      capture_template: {
        tool: "capture_thought",
        arguments: {
          content:
            "Prefers TypeScript over JavaScript. Uses Supabase for all new projects. Favorite editor is VS Code with Vim keybindings.",
        },
      },
      tips: [
        "Claude memories are typically short -- consider grouping related ones into a single thought for richer context",
        "Memories about preferences make good 'note' type thoughts",
        "Memories about people preserve relationship context in Open Brain",
        "Check for duplicates -- Claude may have redundant memories",
      ],
      estimated_effort: "Typically <50 memories: ~5 minutes.",
    },

    "claude-code": {
      platform: "claude-code",
      export_steps: [
        "Locate project directories that have .claude/ folders",
        "Read .claude/CLAUDE.md from each project (project-level instructions/memories)",
        "Check for .claude/memories/ directory and read any files inside",
        "Each CLAUDE.md becomes one thought (prefixed with project name)",
        "Each memory file becomes one thought",
      ],
      format_mapping: {
        source_unit:
          "One CLAUDE.md or memory file = one thought",
        content_template:
          "# Claude Code Memory: {project_name}\n\n{file_content}",
        metadata_notes:
          "Project name should be included so the metadata extractor captures it as a topic",
      },
      capture_template: {
        tool: "capture_thought",
        arguments: {
          content:
            "# Claude Code Memory: open-brain\n\nThis project uses Deno for Edge Functions. Imports use npm: specifiers. No package.json -- Deno resolves at import time. Supabase for storage with pgvector.",
        },
      },
      tips: [
        "CLAUDE.md files often contain both instructions and project knowledge -- both are valuable",
        "Include the project name in the content for better search and categorization",
        "Memory files in .claude/memories/ are typically more granular than CLAUDE.md",
        "Consider one thought per project CLAUDE.md rather than splitting into fragments",
      ],
      estimated_effort: "Per project: ~2 minutes. Typical developer has 5-20 projects: ~30 minutes.",
    },

    generic: {
      platform: "generic",
      export_steps: [
        "Export your data from the source platform in any text-based format (Markdown, plain text, JSON, CSV)",
        "Identify the natural unit of knowledge in your export (one note, one entry, one row)",
        "For each unit, extract the text content",
        "Call capture_thought with the content for each unit",
        "The metadata extractor will automatically identify type, topics, people, and action items",
      ],
      format_mapping: {
        source_unit: "One knowledge unit = one thought",
        content_template: "{content_text}",
        metadata_notes:
          "Include as much context as possible -- titles, tags, dates -- the metadata extractor works best with rich content",
      },
      capture_template: {
        tool: "capture_thought",
        arguments: {
          content:
            "Your exported content goes here. Include any titles, tags, or context from the original platform for better metadata extraction.",
        },
      },
      tips: [
        "Preserve original structure (headers, lists) for better metadata extraction",
        "If your platform has tags or categories, prepend them to the content",
        "Process in chronological order for meaningful weekly reviews",
        "For large migrations, batch in groups of 50 with short delays between batches",
        "Test with 2-3 entries first to verify the content maps well before bulk migration",
      ],
      estimated_effort: "Varies by source platform and volume. Test with a small batch first.",
    },
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerMigrationGuide(mcp: McpServer, z: Z): void {
  mcp.tool("migration_guide", {
    description:
      "Get a structured migration runbook for importing memories from another platform into Open Brain",
    inputSchema: z.object({
      platform: z
        .string()
        .describe(
          "Source platform: notion, obsidian, claude-web, claude-code, or any other platform name",
        ),
    }),
    handler: (args: { platform: string }, _ctx: any) => {
      try {
        const normalized = args.platform.toLowerCase().trim();
        const guides = getGuides();

        // Look up platform, fall back to generic
        const guide = guides[normalized] ?? {
          ...guides["generic"],
          platform: normalized,
        };

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(guide) },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Migration guide failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });
}
