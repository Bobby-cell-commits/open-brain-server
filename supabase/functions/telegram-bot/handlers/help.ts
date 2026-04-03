// handlers/help.ts: /help command — lists available bot commands.

import { sendMessage } from "../telegram.ts";
import type { TelegramMessage } from "../types.ts";

const HELP_TEXT = `🧠 <b>Open Brain Bot</b>

<b>Capture:</b>
Just send any text — it will be captured as a thought with automatic embedding, metadata extraction, dedup, and linking.

<b>Commands:</b>
/search &lt;query&gt; — Search thoughts (coming soon)
/recent [days] — List recent thoughts (coming soon)
/stats [days] — Brain statistics (coming soon)
/help — Show this message`;

export async function handleHelp(message: TelegramMessage): Promise<void> {
  await sendMessage(message.chat.id, HELP_TEXT, {
    reply_to_message_id: message.message_id,
  });
}
