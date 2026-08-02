/** Environment-driven configuration. All secrets come from env vars. */
export const config = {
  // Telegram
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),

  // Numeric Telegram user IDs allowed to talk to the bot.
  allowedUserIds: (process.env.ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Chat the bot sends proactive reminders to (usually your own user id).
  ownerChatId: process.env.OWNER_CHAT_ID ?? "",

  // Notion. Optional: when absent, Notion-backed features are disabled but the
  // bot still runs so you can chat to it.
  notionToken: process.env.NOTION_TOKEN ?? "",
  notionParentPageId: process.env.NOTION_PARENT_PAGE_ID ?? "",

  // Google Calendar. Optional: when absent, calendar features are disabled but
  // the bot still runs. The OAuth client id/secret come from Google Cloud
  // Console (Desktop app); the refresh token is minted once by
  // `scripts/google-auth.mjs` and lives in data/google-token.json, or in
  // GOOGLE_REFRESH_TOKEN for deployments backed by a secret store.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? "",
  googleTokenFile: process.env.GOOGLE_TOKEN_FILE ?? "./data/google-token.json",
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID ?? "",

  // Claude subscription auth. The agent always runs on the subscription token
  // from `claude setup-token` (sk-ant-oat01-...), never a metered API key. The
  // SDK reads it from the environment; we surface it here to validate at startup.
  claudeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",

  // Agent identity and behaviour
  agentName: process.env.AGENT_NAME ?? "Coach",
  timezone: process.env.TIMEZONE ?? "Europe/London",

  // Persona overlays. When enabled, the owner chat gets the Arnold persona and
  // every other chat gets a stable random famous-character voice. The coach's
  // knowledge and safety rules are unchanged; only the tone differs. Set
  // PERSONALITIES_ENABLED=false to keep everyone on the plain coach.
  personalitiesEnabled: (process.env.PERSONALITIES_ENABLED ?? "true") !== "false",

  // The owner's persona: any persona id (e.g. "arnold", "yoda", "sherlock"),
  // "normal" for the plain coach, or "random" for a stable random character.
  ownerPersona: process.env.OWNER_PERSONA ?? "arnold",

  // Models. The main model for real coaching, the fast model for trivial logging.
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
  modelFast: process.env.CLAUDE_MODEL_FAST ?? "claude-haiku-4-5",

  // Route short, clearly-transactional logging messages to the cheaper fast model.
  // Off by default so behaviour is consistent out of the box (every message uses
  // CLAUDE_MODEL); opt in to save subscription usage on trivial logs.
  fastTierEnabled: (process.env.FAST_TIER_ENABLED ?? "false") === "true",

  // Reasoning effort for the standard model: low | medium | high | xhigh | max.
  // Lower means faster, cheaper replies with less deep thinking.
  reasoningEffort: (process.env.REASONING_EFFORT ?? "medium") as
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max",

  // Voice-note transcription: "local", "api", or "off". See docs/configuration.md.
  transcribeProvider: (process.env.TRANSCRIBE_PROVIDER ?? "local") as "local" | "api" | "off",
  transcribeApiUrl:
    process.env.TRANSCRIBE_API_URL ?? "https://api.openai.com/v1/audio/transcriptions",
  transcribeApiKey: process.env.TRANSCRIBE_API_KEY ?? "",
  transcribeModel: process.env.TRANSCRIBE_MODEL ?? "gpt-4o-transcribe",

  // Storage
  sessionFile: process.env.SESSION_FILE ?? "./data/sessions.json",
  scheduleFile: process.env.SCHEDULE_FILE ?? "./data/schedule.json",
  // One JSONL line per agent run (metrics, tool counts, outcome sample). Read
  // back by /stats. See docs/observability.md.
  runLogFile: process.env.RUN_LOG_FILE ?? "./data/agent-runs.jsonl",
  sessionTtlHours: Number.parseInt(process.env.SESSION_TTL_HOURS ?? "12", 10),

  // Transport. "polling" runs an always-on long-polling loop (simplest for local
  // and any always-on host). "webhook" runs an HTTP server that Telegram pushes
  // updates to, which is what lets the service scale to zero instances on a host
  // like Cloud Run. Defaults to webhook when PUBLIC_BASE_URL is set.
  mode: (process.env.MODE ?? (process.env.PUBLIC_BASE_URL ? "webhook" : "polling")) as
    | "polling"
    | "webhook",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  port: Number.parseInt(process.env.PORT ?? "8080", 10),

  // Shared secret the external scheduler (e.g. Cloud Scheduler) must present to
  // call /cron/run. Required in webhook mode so the reminder endpoint is not open.
  cronSecret: process.env.CRON_SECRET ?? "",
} as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Validate configuration at startup, failing fast with a clear message rather than
 * letting a misconfiguration surface later as a 401 or a silently insecure deploy.
 * Covers Claude auth and, in webhook mode, the settings without which the service
 * either cannot register its webhook or would expose an unauthenticated /cron/run.
 */
export function checkClaudeAuth(): void {
  if (!config.claudeOauthToken) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is not set. Run `claude setup-token` and put the " +
        "sk-ant-oat01-... token in your environment.",
    );
  }
  console.log("[config] Claude auth: subscription token");

  if (config.mode === "webhook") {
    if (!config.publicBaseUrl) {
      throw new Error(
        "MODE=webhook requires PUBLIC_BASE_URL (the service's public HTTPS URL) so the " +
          "Telegram webhook can be registered.",
      );
    }
    if (!config.cronSecret) {
      throw new Error(
        "MODE=webhook requires CRON_SECRET so the /cron/run reminder endpoint is " +
          "authenticated. Set a strong random value and share it with your scheduler.",
      );
    }
  }
}
