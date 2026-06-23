# GCP infrastructure (Terraform)

Provisions the full scale-to-zero deployment on Google Cloud:

- **Artifact Registry** Docker repository for the image
- **Cloud Run** service in webhook mode (min 0 / max 1 instance, CPU always
  allocated so background runs finish), with a GCS bucket mounted at `/data`
- a dedicated **runtime service account** with least-privilege access
- **Secret Manager** secrets for the Claude, Telegram, Notion, and cron values
- **Cloud Scheduler** jobs that call `/cron/run` for the seeded reminders

This is the IaC equivalent of `scripts/deploy-cloudrun.sh`. See
[../../docs/deployment.md](../../docs/deployment.md) for how webhook mode works.

## Prerequisites

- Terraform >= 1.5 and the `gcloud` CLI, authenticated:
  `gcloud auth application-default login` and `gcloud config set project <id>`.
- A Claude subscription token (`claude setup-token`), a Telegram bot token, and a
  long random `cron_secret`.

## Deploy (two steps)

Cloud Run needs the image to exist before it can start, and the image lives in the
Artifact Registry this stack creates. So apply the registry first, push the image,
then apply the rest.

```bash
cd infra/gcp
cp terraform.tfvars.example terraform.tfvars   # then fill it in
terraform init

# 1. Create just the Artifact Registry (and enable APIs).
terraform apply -target=google_artifact_registry_repository.this

# 2. Build and push the image to it (run from the repo root).
cd ../..
gcloud builds submit \
  --tag "$(cd infra/gcp && terraform output -raw artifact_registry_repo)/fitcoach-agent:latest"

# 3. Apply the rest (Cloud Run, secrets, scheduler).
cd infra/gcp
terraform apply
```

`terraform output service_url` prints the public URL; the Telegram webhook
registers itself there on startup. On later code changes, rebuild and push the
image (step 2) and re-run `terraform apply` (a new revision rolls out; bump
`image_tag` if you tag by version).

## Notes

- `terraform.tfvars` holds secrets. It is gitignored; keep it private. For teams,
  prefer a remote backend with state encryption and pass secrets via `TF_VAR_*`
  or a secrets manager rather than a file.
- The service allows unauthenticated invocations because Telegram must reach the
  webhook; the endpoints are protected at the application layer (`CRON_SECRET`
  and the Telegram id allowlist).
- Cloud Scheduler interprets the schedule in `timezone`. Adjust `reminders` in
  `terraform.tfvars` to change times or add jobs.
