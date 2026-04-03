// telegram-bot/index.ts: Webhook entry point for Telegram Bot.
// Verifies secret token, authorizes by chat ID, routes to handlers.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

import { errorResponse } from "../_shared/errors.ts";
import { handleCapture } from "./handlers/capture.ts";
import { handleHelp } from "./handlers/help.ts";
import type { TelegramUpdate } from "./types.ts";

const OK_RESPONSE = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

export async function handleRequest(req: Request): Promise<Response> {
  // Only accept POST
  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  // Verify secret token
  const secretToken = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  const expectedToken = Deno.env.get("TELEGRAM_SECRET_TOKEN");
  if (!secretToken || secretToken !== expectedToken) {
    return errorResponse("Unauthorized", 401);
  }

  const update: TelegramUpdate = await req.json();

  // Only handle message updates
  if (!update.message) {
    return OK_RESPONSE();
  }

  const message = update.message;

  // Authorize: only process messages from allowed chat
  const allowedChatId = parseInt(Deno.env.get("TELEGRAM_ALLOWED_CHAT_ID") ?? "0", 10);
  if (message.chat.id !== allowedChatId) {
    return OK_RESPONSE(); // Silent drop
  }

  const text = message.text ?? "";

  // Ignore non-text messages (photos, stickers, voice, etc.)
  if (!text) {
    return OK_RESPONSE();
  }

  // Route commands — process in background, respond 200 immediately
  if (text.startsWith("/help")) {
    EdgeRuntime.waitUntil(handleHelp(message));
  } else if (text.startsWith("/search")) {
    // Phase 2 — not yet implemented
    EdgeRuntime.waitUntil(
      (async () => {
        const { sendMessage } = await import("./telegram.ts");
        await sendMessage(message.chat.id, "🚧 /search coming soon. Use MCP for now.", {
          reply_to_message_id: message.message_id,
        });
      })(),
    );
  } else if (text.startsWith("/recent")) {
    EdgeRuntime.waitUntil(
      (async () => {
        const { sendMessage } = await import("./telegram.ts");
        await sendMessage(message.chat.id, "🚧 /recent coming soon. Use MCP for now.", {
          reply_to_message_id: message.message_id,
        });
      })(),
    );
  } else if (text.startsWith("/stats")) {
    EdgeRuntime.waitUntil(
      (async () => {
        const { sendMessage } = await import("./telegram.ts");
        await sendMessage(message.chat.id, "🚧 /stats coming soon. Use MCP for now.", {
          reply_to_message_id: message.message_id,
        });
      })(),
    );
  } else if (text.startsWith("/")) {
    // Unknown command
    EdgeRuntime.waitUntil(
      (async () => {
        const { sendMessage } = await import("./telegram.ts");
        await sendMessage(message.chat.id, "Unknown command. Try /help", {
          reply_to_message_id: message.message_id,
        });
      })(),
    );
  } else {
    // Plain text → capture
    EdgeRuntime.waitUntil(handleCapture(message));
  }

  return OK_RESPONSE();
}

Deno.serve(handleRequest);
