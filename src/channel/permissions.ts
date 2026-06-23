import { config } from "../config.js";

/**
 * Single-user (or small allowlist) access control. A Telegram user may talk to
 * the bot only if their numeric id is in ALLOWED_TELEGRAM_IDS. Everyone else is
 * silently ignored, which keeps a public bot from being abused by strangers.
 */
export function isAllowed(telegramUserId: number | string): boolean {
  return config.allowedUserIds.includes(String(telegramUserId));
}
