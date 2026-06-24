terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "this" {}

locals {
  # Cloud Run's deterministic per-project URL. Used to set PUBLIC_BASE_URL on the
  # service itself (referencing the service's own .uri would be a dependency
  # cycle) and as the Cloud Scheduler target.
  service_url = "https://${var.service_name}-${data.google_project.this.number}.${var.region}.run.app"

  image = "${var.region}-docker.pkg.dev/${var.project_id}/${var.repository_id}/${var.service_name}:${var.image_tag}"

  # Non-secret environment, with Notion parent page only when provided.
  plain_env = merge(
    {
      MODE                  = "webhook"
      HOME                  = "/data"
      TIMEZONE              = var.timezone
      AGENT_NAME            = var.agent_name
      SESSION_FILE          = "/data/sessions.json"
      SCHEDULE_FILE         = "/data/schedule.json"
      ALLOWED_TELEGRAM_IDS  = var.allowed_telegram_ids
      OWNER_CHAT_ID         = var.owner_chat_id
      PERSONALITIES_ENABLED = tostring(var.personalities_enabled)
      PUBLIC_BASE_URL       = local.service_url
    },
    var.notion_parent_page_id != "" ? { NOTION_PARENT_PAGE_ID = var.notion_parent_page_id } : {}
  )

  # Secret-backed environment. Notion is included only when a token is supplied.
  secret_env = concat(
    [
      { name = "CLAUDE_CODE_OAUTH_TOKEN", secret_id = google_secret_manager_secret.claude.secret_id },
      { name = "TELEGRAM_BOT_TOKEN", secret_id = google_secret_manager_secret.telegram.secret_id },
      { name = "CRON_SECRET", secret_id = google_secret_manager_secret.cron.secret_id },
    ],
    var.notion_token != "" ? [{ name = "NOTION_TOKEN", secret_id = google_secret_manager_secret.notion[0].secret_id }] : []
  )

  apis = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "cloudbuild.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# ── Artifact Registry ─────────────────────────────────────────────────────────
resource "google_artifact_registry_repository" "this" {
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = "Container images for the fitcoach agent."
  depends_on    = [google_project_service.apis]
}

# ── Durable storage for sessions/schedule (mounted at /data) ───────────────────
resource "google_storage_bucket" "data" {
  name                        = "${var.project_id}-${var.service_name}-data"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false
  depends_on                  = [google_project_service.apis]
}

# ── Runtime service account ────────────────────────────────────────────────────
resource "google_service_account" "run" {
  account_id   = "${var.service_name}-run"
  display_name = "FitCoach Cloud Run runtime"
}

resource "google_storage_bucket_iam_member" "data_rw" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.run.email}"
}

# ── Secrets ─────────────────────────────────────────────────────────────────────
resource "google_secret_manager_secret" "claude" {
  secret_id = "${var.service_name}-claude-oauth"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}
resource "google_secret_manager_secret_version" "claude" {
  secret      = google_secret_manager_secret.claude.id
  secret_data = var.claude_oauth_token
}

resource "google_secret_manager_secret" "telegram" {
  secret_id = "${var.service_name}-telegram-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}
resource "google_secret_manager_secret_version" "telegram" {
  secret      = google_secret_manager_secret.telegram.id
  secret_data = var.telegram_bot_token
}

resource "google_secret_manager_secret" "cron" {
  secret_id = "${var.service_name}-cron-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}
resource "google_secret_manager_secret_version" "cron" {
  secret      = google_secret_manager_secret.cron.id
  secret_data = var.cron_secret
}

resource "google_secret_manager_secret" "notion" {
  count     = var.notion_token != "" ? 1 : 0
  secret_id = "${var.service_name}-notion-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}
resource "google_secret_manager_secret_version" "notion" {
  count       = var.notion_token != "" ? 1 : 0
  secret      = google_secret_manager_secret.notion[0].id
  secret_data = var.notion_token
}

# Grant the runtime SA read access to every secret it consumes.
resource "google_secret_manager_secret_iam_member" "access" {
  for_each = {
    for s in local.secret_env : s.name => s.secret_id
  }
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

# ── Cloud Run service (webhook mode, scale to zero, CPU always allocated) ───────
resource "google_cloud_run_v2_service" "this" {
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account       = google_service_account.run.email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    volumes {
      name = "data"
      gcs {
        bucket    = google_storage_bucket.data.name
        read_only = false
      }
    }

    containers {
      image = local.image

      resources {
        # cpu_idle = false keeps CPU allocated after the response so the
        # background agent run finishes (equivalent to --no-cpu-throttling).
        cpu_idle = false
      }

      ports {
        container_port = 8080
      }

      volume_mounts {
        name       = "data"
        mount_path = "/data"
      }

      dynamic "env" {
        for_each = local.plain_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = { for e in local.secret_env : e.name => e.secret_id }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  # The image must already exist in Artifact Registry (see README two-step apply).
  depends_on = [
    google_secret_manager_secret_version.claude,
    google_secret_manager_secret_version.telegram,
    google_secret_manager_secret_version.cron,
    google_secret_manager_secret_iam_member.access,
    google_storage_bucket_iam_member.data_rw,
  ]
}

# The Telegram webhook must reach the service, so allow unauthenticated invokes.
# Application-level secrets (CRON_SECRET, the allowlist) protect the endpoints.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.this.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ── Cloud Scheduler reminders (call /cron/run with the cron secret) ─────────────
resource "google_cloud_scheduler_job" "reminders" {
  for_each  = var.reminders
  name      = "${var.service_name}-${each.key}"
  region    = var.region
  schedule  = each.value.schedule
  time_zone = var.timezone

  http_target {
    uri         = "${local.service_url}/cron/run"
    http_method = "POST"
    headers = {
      "Authorization" = "Bearer ${var.cron_secret}"
      "Content-Type"  = "application/json"
    }
    body = base64encode(jsonencode({ taskId = each.value.task_id }))
  }

  depends_on = [google_project_service.apis, google_cloud_run_v2_service.this]
}
