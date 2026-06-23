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

variable "reminders" {
  type        = map(object({ schedule = string, task_id = string }))
  description = "Cloud Scheduler reminder jobs, keyed by job name suffix."
  default = {
    "morning-nudge" = { schedule = "0 8 * * *", task_id = "morning-nudge" }
    "weekly-plan"   = { schedule = "0 18 * * 0", task_id = "weekly-plan" }
  }
}
