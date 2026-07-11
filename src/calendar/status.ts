import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/**
 * Google Calendar access.
 *
 * The agent talks to Google Calendar exclusively through its REST API, driven
 * by the bundled `scripts/calendar.mjs` helper (run via Bash), mirroring how
 * Notion is integrated. Auth is OAuth2: a refresh token minted once by
 * `scripts/google-auth.mjs` (stored in data/google-token.json, or provided as
 * GOOGLE_REFRESH_TOKEN in deployments), exchanged for short-lived access
 * tokens on demand.
 *
 * Configured means: OAuth client id and secret are set, and a refresh token is
 * available from either source. When not configured the bot runs fine; session
 * reminders then rely on the Telegram scheduler alone.
 */
export function googleCalendarConfigured(): boolean {
  if (!config.googleClientId || !config.googleClientSecret) return false;
  if (config.googleRefreshToken) return true;
  try {
    const tokenPath = path.resolve(process.cwd(), config.googleTokenFile);
    const token = JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as {
      refresh_token?: string;
    };
    return Boolean(token.refresh_token);
  } catch {
    return false;
  }
}
