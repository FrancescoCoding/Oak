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

  // Agent identity and behaviour
  agentName: process.env.AGENT_NAME ?? "Coach",
  timezone: process.env.TIMEZONE ?? "Europe/London",

  // Persona overlays. When enabled, the owner chat gets the Arnold persona and
  // every other chat gets a stable random famous-character voice. The coach's
  // knowledge and safety rules are unchanged; only the tone differs. Set
  // PERSONALITIES_ENABLED=false to keep everyone on the plain coach.
  personalitiesEnabled: (process.env.PERSONALITIES_ENABLED ?? "true") !== "false",

  // Models. Sonnet for real coaching, the fast model for trivial logging.
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
  modelFast: process.env.CLAUDE_MODEL_FAST ?? "claude-haiku-4-5",

  // Reasoning effort for the standard model: low | medium | high | xhigh | max.
  // Lower means faster, cheaper replies with less deep thinking.
  reasoningEffort: (process.env.REASONING_EFFORT ?? "medium") as
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max",

  // Storage
  sessionFile: process.env.SESSION_FILE ?? "./data/sessions.json",
  scheduleFile: process.env.SCHEDULE_FILE ?? "./data/schedule.json",
  sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS ?? "12", 10),

  // Transport. "polling" runs an always-on long-polling loop (simplest for local
  // and any always-on host). "webhook" runs an HTTP server that Telegram pushes
  // updates to, which is what lets the service scale to zero instances on a host
  // like Cloud Run. Defaults to webhook when PUBLIC_BASE_URL is set.
  mode: (process.env.MODE ?? (process.env.PUBLIC_BASE_URL ? "webhook" : "polling")) as
    | "polling"
    | "webhook",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  port: parseInt(process.env.PORT ?? "8080", 10),

  // Shared secret the external scheduler (e.g. Cloud Scheduler) must present to
  // call /cron/run. Required in webhook mode so the reminder endpoint is not open.
  cronSecret: process.env.CRON_SECRET ?? "",
} as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
