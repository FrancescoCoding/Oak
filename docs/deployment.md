# Deployment

The agent runs in one of two modes. The right one depends only on whether your
host keeps a process running or idles it to zero. All settings are environment
variables; see [configuration.md](./configuration.md).

## Always-on (polling mode, the default)

Anything that keeps a container alive: your own machine, a home server or
Raspberry Pi, a small VPS, or a platform like Railway, Render, or Fly with one
machine kept running. Nothing to configure beyond `.env`: the bot long-polls
Telegram and the built-in scheduler (croner) fires your reminders. This is what
`docker compose up -d` does.

```bash
# Plain Docker, anywhere:
docker build -t fitcoach-agent .
docker run -d --name fitcoach --env-file .env -v fitcoach-data:/data -p 8080:8080 fitcoach-agent
```

`/data` holds sessions, the schedule, and the Notion id cache; mount it as a
volume so they survive restarts. `/healthz` on port 8080 reports health.

> Only one instance may poll a given bot token at a time. If you also run it
> locally while a deployed copy is up, Telegram returns a 409 conflict. Stop one,
> or use a separate bot token for local development.

## Scale-to-zero (webhook mode)

For serverless hosts that idle to zero instances when no one is chatting (Google
Cloud Run and similar). Polling cannot scale to zero (it needs a running loop),
so the agent switches to webhooks. Set these and the rest is automatic:

- `MODE=webhook` and `PUBLIC_BASE_URL` (your service's HTTPS URL). The bot
  registers its Telegram webhook at `PUBLIC_BASE_URL/webhook/telegram`, acks each
  update instantly, and runs in the background (duplicates dropped).
- `CRON_SECRET`, then point an external scheduler at `POST /cron/run` (one call
  per reminder, body `{"taskId":"morning-nudge"}`) since the in-process cron does
  not run at 0 instances.
- Durable storage for `/data` and `HOME` (a mounted bucket or volume) so sessions
  and the SDK resume transcripts survive cold starts.

Two host requirements: the platform must **keep CPU allocated after the HTTP
response** so the background run finishes (on Cloud Run that is
`--no-cpu-throttling`), and you should cap it to **one instance** so a single
instance owns the mounted storage.

**Voice notes:** do not run local Whisper here. It loads a model into memory,
which would force a large, always-paid instance even for plain text messages. On
scale-to-zero set `TRANSCRIBE_PROVIDER=api` (OpenAI `gpt-4o-transcribe` by
default) so transcription is a quick API call and the instance stays small
(~1 GiB). Reserve `local` for always-on self-hosting where the RAM is free.

### Ready-to-use examples

The same pattern (webhook URL + external cron + durable volume) maps to any
scale-to-zero host. Two examples ship with the repo:

- **Google Cloud Run (Terraform, recommended)**: [`infra/gcp/`](../infra/gcp/)
  provisions Artifact Registry, the Cloud Run service (min 0 / max 1, CPU always
  allocated), a runtime service account, Secret Manager secrets, a GCS bucket at
  `/data`, and the Cloud Scheduler jobs. See [infra/gcp/README.md](../infra/gcp/README.md)
  for the two-step apply (create the registry, push the image, apply the rest).
- **Google Cloud Run (script)**: [`scripts/deploy-cloudrun.sh`](../scripts/deploy-cloudrun.sh)
  is the imperative equivalent: builds, deploys with `--min-instances 0
  --no-cpu-throttling`, mounts a GCS bucket at `/data`, and creates the scheduler jobs.
- **Azure Container Apps**: [`infra/azure/`](../infra/azure/) provisions the
  environment, an Azure Files share for `/data`, the app scaled to zero replicas
  with external ingress, and scheduled Container Apps Jobs that call `/cron/run`.
  See [infra/azure/README.md](../infra/azure/README.md) for the deploy steps.

See [infra/README.md](../infra/README.md) for an index of the available setups.
