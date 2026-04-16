// telegram.ts: Re-exports shared Telegram utilities + capture-specific formatting.

import type { ThoughtMetadata } from "../_shared/types.ts";

// Re-export shared Telegram functions
export { sendMessage, setReaction, escapeHtml, getAllowedChatId } from "../_shared/telegram.ts";
export type { SendMessageOptions } from "../_shared/telegram.ts";

export function formatConfirmation(metadata: ThoughtMetadata): string {
  // Import escapeHtml locally to avoid circular re-export issues
  const escape = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines: string[] = ["\u{1F9E0} <b>Captured!</b>"];

  if (metadata.type) {
    lines.push(`  <b>Type:</b> ${escape(metadata.type)}`);
  }
  if (metadata.theme) {
    lines.push(`  <b>Theme:</b> ${escape(metadata.theme)}`);
  }
  if (metadata.activity) {
    lines.push(`  <b>Activity:</b> ${escape(metadata.activity)}`);
  }
  if (metadata.topics?.length > 0) {
    lines.push(`  <b>Topics:</b> ${metadata.topics.map(escape).join(", ")}`);
  }
  if (metadata.quality !== undefined) {
    lines.push(`  <b>Quality:</b> ${(metadata.quality as number).toFixed(1)}`);
  }
  if (metadata.people?.length > 0) {
    lines.push(`  <b>People:</b> ${metadata.people.map(escape).join(", ")}`);
  }
  if (metadata.action_items?.length > 0) {
    const items = metadata.action_items
      .map((ai) =>
        `${escape(ai.task)}${ai.assignee ? ` (${escape(ai.assignee)})` : ""}${ai.due ? ` by ${ai.due}` : ""}`
      )
      .join("; ");
    lines.push(`  <b>Action items:</b> ${items}`);
  }
  if (metadata.dates_mentioned?.length > 0) {
    lines.push(`  <b>Dates:</b> ${metadata.dates_mentioned.join(", ")}`);
  }
  if (metadata.relevance) {
    lines.push(`  <b>Why:</b> ${escape(metadata.relevance)}`);
  }

  return lines.join("\n");
}
