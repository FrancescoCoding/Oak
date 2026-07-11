# Configuration

All configuration is via environment variables, loaded from `.env` locally
(`npm run dev`/`npm start` read it automatically) or injected by your host in
production. [`.env.example`](../.env.example) is the source of truth with inline
comments; this page explains each setting.

## Required

| Variable | What it is |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude **subscription** token from `claude setup-token` (`sk-ant-oat01-...`). No metered cost; the bot validates it at startup. |
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather). |
| `ALLOWED_TELEGRAM_IDS` | Comma-separated numeric user ids allowed to use the bot. Everyone else is ignored. Find yours via [@userinfobot](https://t.me/userinfobot). |
| `OWNER_CHAT_ID` | Chat that receives proactive reminders, usually your own id. |

## Notion (optional but recommended)

| Variable | What it is |
|---|---|
| `NOTION_TOKEN` | Internal integration token from [notion.com/my-integrations](https://www.notion.com/my-integrations). Blank disables all Notion persistence; the bot still chats. |
| `NOTION_PARENT_PAGE_ID` | The Hub page under which the workspace is built. If unset, the agent asks you to share a page on first setup. |

Share the Hub page with your integration (Notion Share menu) or nothing is
visible to the agent. See [notion-architecture.md](./notion-architecture.md) for
what gets built.

## Google Calendar (optional)

Puts planned training sessions on your Google Calendar with native phone
reminders (so you do not need to rely on Telegram notifications), and lets the
coach plan around your real commitments.

| Variable | What it is |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth "Desktop app" client credentials from Google Cloud Console (enable the Calendar API and add yourself as a consent-screen test user first). Blank disables calendar sync; the bot still runs. |
| `GOOGLE_REFRESH_TOKEN` | Optional. For deployments without the token file: the `refresh_token` value from `data/google-token.json`, stored as a secret. |
| `GOOGLE_CALENDAR_ID` | Optional. Which calendar to write to. Defaults to the calendar chosen with `calendar.mjs use-calendar`, then `primary`. |
| `GOOGLE_TOKEN_FILE` | Optional. Path of the token store, default `./data/google-token.json` (point it at a mounted volume on scale-to-zero hosts). |

After setting the client id and secret, authorise once with
`node --env-file=.env scripts/google-auth.mjs`. See
[google-calendar-architecture.md](./google-calendar-architecture.md).

## Agent identity and behaviour

| Variable | Default | What it is |
|---|---|---|
| `AGENT_NAME` | `Coach` | What the coach calls itself (plain-coach mode). |
| `TIMEZONE` | `Europe/London` | Timezone for reminders and the message-header clock. |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Model for real coaching, planning, and advice (and for everything unless the fast tier is enabled). Set to `claude-opus-4-8` for Opus. |
| `CLAUDE_MODEL_FAST` | `claude-haiku-4-5` | Cheaper model used for trivial logging messages, only when `FAST_TIER_ENABLED=true`. |
| `FAST_TIER_ENABLED` | `false` | When `true`, short transactional logging messages on new chats route to `CLAUDE_MODEL_FAST` to save subscription usage. Off by default so every message uses `CLAUDE_MODEL` for consistent behaviour. |
| `REASONING_EFFORT` | `medium` | Thinking depth for the standard model: `low \| medium \| high \| xhigh \| max`. Lower is faster and cheaper. |
| `PERSONALITIES_ENABLED` | `true` | Persona overlays (owner gets Arnold, others a stable random character). `false` keeps everyone on the plain coach. See [customization.md](./customization.md). |

## Storage

| Variable | Default | What it is |
|---|---|---|
| `SESSION_FILE` | `./data/sessions.json` | Per-chat Claude session ids. |
| `SCHEDULE_FILE` | `./data/schedule.json` | Reminder schedule. |
| `SESSION_TTL_HOURS` | `12` | How long a conversation stays warm before a fresh session starts. |

In Docker these live on a mounted volume so they survive restarts. The Notion id
cache (`data/notion-ids.json`) also lives here.

## Transport mode

| Variable | Default | What it is |
|---|---|---|
| `MODE` | `polling` (or `webhook` if `PUBLIC_BASE_URL` is set) | `polling` long-polls Telegram (always-on hosts); `webhook` runs an HTTP server for scale-to-zero hosts. |
| `PUBLIC_BASE_URL` | (none) | Required in webhook mode: the service's public HTTPS URL. Startup fails fast if `MODE=webhook` and this is unset. |
| `PORT` | `8080` | HTTP port (health checks, webhook, scheduler). |
| `CRON_SECRET` | (none) | Required in webhook mode: bearer secret an external scheduler sends to `POST /cron/run`. Startup fails fast if `MODE=webhook` and this is unset, so the reminder endpoint is never left unauthenticated. |

See [deployment.md](./deployment.md) for how the two modes map to hosts.

## Optional integrations

| Variable | Default | What it is |
|---|---|---|
| `TRANSCRIBE_PROVIDER` | `local` | Voice-note transcription: `local` (in-process Whisper, free/private, needs RAM, self-hosting only), `api` (OpenAI-compatible endpoint, tiny memory, needs a key, right for the cloud), or `off` (disable voice). |
| `WHISPER_MODEL` | `Xenova/whisper-base` | Local model when `TRANSCRIBE_PROVIDER=local`. `whisper-tiny` faster, `whisper-small` more accurate. |
| `TRANSCRIBE_API_KEY` | (none) | Required for `api`. The transcription provider's key (e.g. your OpenAI key). This is separate from your Claude auth. |
| `TRANSCRIBE_API_URL` | OpenAI `/audio/transcriptions` | OpenAI-compatible transcription URL. Point at another provider (e.g. Groq) if preferred. |
| `TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | Model for the `api` provider. `gpt-4o-transcribe` tops accuracy benchmarks; `gpt-4o-mini-transcribe` is cheaper. |
| `EXERCISE_DB_URL` | free-exercise-db raw JSON | Override only if you self-host the exercise dataset. |

> **Deployments:** local Whisper forces a large, always-paid instance (the model
> sits in memory for every request, voice or not), so on scale-to-zero hosts set
> `TRANSCRIBE_PROVIDER=api` (OpenAI `gpt-4o-transcribe` by default) and keep the
> instance small (~1 GiB). Reserve `local` for self-hosting where you have the RAM.
| `EXERCISE_DB_IMAGE_BASE` | free-exercise-db images | Override only if you self-host the exercise images. |

## Reminders

Two reminders are seeded by default: a morning session nudge (08:00) and the
Sunday weekly plan (18:00), in `TIMEZONE`. Ask the coach in chat to add, change,
or remove reminders ("remind me to train at 6pm on weekdays") and it manages them
live in polling mode. In webhook mode the agent records the request but an
external scheduler must run the job (see [deployment.md](./deployment.md)).
