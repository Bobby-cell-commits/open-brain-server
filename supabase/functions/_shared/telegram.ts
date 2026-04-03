// Shared Telegram Bot API client.
// Used by telegram-bot (capture confirmations) and monitor-pipeline (health alerts).

function getBotToken(): string {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return token;
}

function getAllowedChatId(): number {
  const id = parseInt(Deno.env.get("TELEGRAM_ALLOWED_CHAT_ID") ?? "0", 10);
  if (!id) throw new Error("TELEGRAM_ALLOWED_CHAT_ID not set");
  return id;
}

const BASE_URL = () => `https://api.telegram.org/bot${getBotToken()}`;

interface SendMessageOptions {
  reply_to_message_id?: number;
  parse_mode?: string;
}

export async function sendMessage(
  chatId: number,
  text: string,
  options: SendMessageOptions = {},
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: options.parse_mode ?? "HTML",
  };
  if (options.reply_to_message_id) {
    body.reply_to_message_id = options.reply_to_message_id;
  }

  const response = await fetch(`${BASE_URL()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`Telegram sendMessage failed (${response.status}): ${err}`);
  }
}

export async function setReaction(
  chatId: number,
  messageId: number,
  emoji: string,
): Promise<void> {
  try {
    await fetch(`${BASE_URL()}/setMessageReaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      }),
    });
  } catch {
    // Fire-and-forget — reactions are non-critical
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export { getAllowedChatId };
export type { SendMessageOptions };
