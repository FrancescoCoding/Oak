variable "project_id" {
  type        = string
  description = "GCP project id to deploy into."
}

variable "region" {
  type        = string
  description = "Region for Artifact Registry, Cloud Run, and Cloud Scheduler."
  default     = "europe-west1"
}

variable "service_name" {
  type        = string
  description = "Cloud Run service name (also used as the image name)."
  default     = "fitcoach-agent"
}

variable "repository_id" {
  type        = string
  description = "Artifact Registry Docker repository id."
  default     = "fitcoach"
}

variable "image_tag" {
  type        = string
  description = "Image tag to deploy. Build and push this tag before a full apply."
  default     = "latest"
}

# ── Coach configuration (non-secret) ──────────────────────────────────────────
variable "timezone" {
  type    = string
  default = "Europe/London"
}

variable "agent_name" {
  type    = string
  default = "Coach"
}

variable "allowed_telegram_ids" {
  type        = string
  description = "Comma-separated numeric Telegram user ids allowed to use the bot."
}

variable "owner_chat_id" {
  type        = string
  description = "Telegram chat id that receives proactive reminders."
}

variable "notion_parent_page_id" {
  type        = string
  description = "Optional Notion Hub page id. Leave empty to set it later."
  default     = ""
}

variable "personalities_enabled" {
  type        = bool
  description = "Persona overlays. Defaults to false so a fresh deploy is neutral."
  default     = false
}

variable "owner_persona" {
  type        = string
  description = "Optional persona overlay for the owner (requires personalities_enabled)."
  default     = ""
}

variable "claude_model" {
  type        = string
  description = "Optional Claude model override (e.g. claude-sonnet-5). Empty uses the SDK default."
  default     = ""
}

variable "transcribe_provider" {
  type        = string
  description = "Voice note transcription: 'api' (recommended on scale-to-zero), 'local', or 'off'."
  default     = "api"
}

variable "transcribe_api_url" {
  type    = string
  default = "https://api.openai.com/v1/audio/transcriptions"
}

variable "transcribe_model" {
  type    = string
  default = "gpt-4o-transcribe"
}

variable "google_client_id" {
  type        = string
  description = "Optional Google OAuth client id for Calendar sync. Empty disables calendar."
  default     = ""
}

# ── Secrets (stored in Secret Manager) ────────────────────────────────────────
variable "claude_oauth_token" {
  type        = string
  description = "Claude subscription token from `claude setup-token`."
  sensitive   = true
}

variable "telegram_bot_token" {
  type        = string
  description = "Telegram bot token from @BotFather."
  sensitive   = true
}

variable "notion_token" {
  type        = string
  description = "Notion integration token. Leave empty to run without Notion."
  sensitive   = true
  default     = ""
}

variable "cron_secret" {
  type        = string
  description = "Shared secret Cloud Scheduler sends to /cron/run. Use a long random value."
  sensitive   = true
}

variable "transcribe_api_key" {
  type        = string
  description = "API key for transcribe_provider=api (e.g. OpenAI). Empty skips the secret."
  sensitive   = true
  default     = ""
}

variable "google_client_secret" {
  type        = string
  description = "Google OAuth client secret for Calendar sync. Empty skips calendar secrets."
  sensitive   = true
  default     = ""
}

variable "google_refresh_token" {
  type        = string
  description = "Google OAuth refresh token from `node scripts/google-auth.mjs`."
  sensitive   = true
  default     = ""
}

variable "reminders" {
  type        = map(object({ schedule = string, task_id = string }))
  description = "Cloud Scheduler reminder jobs, keyed by job name suffix."
  default = {
    "morning-nudge" = { schedule = "0 8 * * *", task_id = "morning-nudge" }
    "weekly-plan"   = { schedule = "0 18 * * 0", task_id = "weekly-plan" }
  }
}
