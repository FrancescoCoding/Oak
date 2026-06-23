# Infrastructure

Infrastructure-as-code for deploying the agent to a scale-to-zero host (webhook
mode). Pick your cloud; each folder is self-contained with its own setup guide.

| Cloud | Stack | Setup guide |
|---|---|---|
| Google Cloud | Cloud Run + Artifact Registry (Terraform) | [gcp/README.md](./gcp/README.md) |
| Azure | Container Apps + Azure Files (Bicep) | [azure/README.md](./azure/README.md) |

Both provision the same shape: the container scaled to zero with external
ingress, durable storage mounted at `/data`, secrets, and scheduled jobs that
call `/cron/run` for reminders. See [../docs/deployment.md](../docs/deployment.md)
for how webhook mode and the two transport modes work, and
[../scripts/deploy-cloudrun.sh](../scripts/deploy-cloudrun.sh) for an imperative
Cloud Run alternative to the Terraform stack.

For always-on hosting (your machine, a VPS, a Raspberry Pi) you do not need any of
this; just `docker compose up -d`. See the deployment doc.
