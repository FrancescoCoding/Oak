#!/bin/bash
#
# Deploy the fitcoach agent to Cloud Run in webhook mode (scale to zero) and wire
# up Cloud Scheduler for the seeded reminders. Edit the variables below, store the
# secrets in Secret Manager first, then run this script.
#
# Prerequisites:
#   - gcloud authenticated and the project set.
#   - Secrets created: claude-oauth, telegram-token, notion-token, cron-secret.
#   - A GCS bucket for durable sessions.
set -euo pipefail

PROJECT="your-project"
REGION="europe-west1"
REPO="your-artifact-repo"
SERVICE="fitcoach-agent"
BUCKET="your-sessions-bucket"
TIMEZONE="Europe/London"
ALLOWED_IDS="YOUR_TELEGRAM_ID"
OWNER_CHAT_ID="YOUR_TELEGRAM_ID"

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}"

echo "Building and pushing ${IMAGE}..."
gcloud builds submit --tag "${IMAGE}"

echo "Deploying ${SERVICE}..."
gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --min-instances 0 --max-instances 1 \
  --no-cpu-throttling \
  --add-volume "name=data,type=cloud-storage,bucket=${BUCKET}" \
  --add-volume-mount "volume=data,mount-path=/data" \
  --set-env-vars "MODE=webhook,HOME=/data,TIMEZONE=${TIMEZONE},AGENT_NAME=Coach" \
  --set-env-vars "SESSION_FILE=/data/sessions.json,SCHEDULE_FILE=/data/schedule.json" \
  --set-env-vars "ALLOWED_TELEGRAM_IDS=${ALLOWED_IDS},OWNER_CHAT_ID=${OWNER_CHAT_ID}" \
  --set-secrets "CLAUDE_CODE_OAUTH_TOKEN=claude-oauth:latest,TELEGRAM_BOT_TOKEN=telegram-token:latest,NOTION_TOKEN=notion-token:latest,CRON_SECRET=cron-secret:latest"

URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format 'value(status.url)')"
echo "Service URL: ${URL}"

echo "Setting PUBLIC_BASE_URL and redeploying so the Telegram webhook registers..."
gcloud run services update "${SERVICE}" --region "${REGION}" \
  --set-env-vars "PUBLIC_BASE_URL=${URL}"

# Cloud Scheduler needs the cron secret to call /cron/run. Read it back from Secret
# Manager so it is not duplicated here.
CRON_SECRET="$(gcloud secrets versions access latest --secret cron-secret)"

create_job() {
  local name="$1" schedule="$2" task_id="$3"
  echo "Scheduling ${name} (${schedule})..."
  gcloud scheduler jobs create http "${name}" \
    --location "${REGION}" --schedule "${schedule}" --time-zone "${TIMEZONE}" \
    --uri "${URL}/cron/run" --http-method POST \
    --headers "Authorization=Bearer ${CRON_SECRET},Content-Type=application/json" \
    --message-body "{\"taskId\":\"${task_id}\"}" \
    || echo "  (job ${name} may already exist; update it with 'gcloud scheduler jobs update http')"
}

create_job "fitcoach-morning-nudge" "0 8 * * *" "morning-nudge"
create_job "fitcoach-weekly-plan" "0 18 * * 0" "weekly-plan"

echo "Done."
