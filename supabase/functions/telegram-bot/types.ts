// types.ts: Minimal Telegram Bot API type definitions.
// Only what we use — not a full SDK.

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  date: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}
