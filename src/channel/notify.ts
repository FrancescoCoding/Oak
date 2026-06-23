import type { Bot } from "grammy";
import { toTelegramHtml, toPlainText } from "./format.js";
import { redactSecrets } from "../util/redact.js";

/**
 * Proactive messaging. The scheduler (and any other background task) uses this to
 * push messages to a chat without an incoming update to reply to. Mirrors the
 * inbound reply path: secrets scrubbed, Markdown converted to Telegram HTML, with
 * a plain-text fallback if Telegram rejects the entities.
 */

let botRef: Bot | null = null;

export function registerBot(bot: Bot): void {
  botRef = bot;
}

export async function sendMessage(chatId: string | number, text: string): Promise<void> {
  if (!botRef) {
    console.warn("[notify] No bot registered, cannot send message");
    return;
  }
  const safe = redactSecrets(text);
  for (const chunk of splitMessage(safe, 4096)) {
    try {
      await botRef.api.sendMessage(chatId, toTelegramHtml(chunk), { parse_mode: "HTML" });
    } catch {
      await botRef.api.sendMessage(chatId, toPlainText(chunk));
    }
  }
}

/** Split a message into Telegram-sized chunks, preferring to break on newlines. */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
