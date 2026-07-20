# Oak - A Personal Fitness Goals Agent

[![CI](https://github.com/FrancescoCoding/Oak/actions/workflows/ci.yml/badge.svg)](https://github.com/FrancescoCoding/Oak/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![Code style: Biome](https://img.shields.io/badge/code%20style-biome-60a5fa.svg)](https://biomejs.dev)

A personal fitness coach, motivator, and food advisor you talk to on **Telegram**. It runs on
the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), keeps your training
log in **Notion**, recommends what to train, builds your weekly plan, transcribes your voice
notes, looks at your meal photos, and sends you reminders.

It runs on your **Claude subscription** (no metered API key), so you are not paying per token
on top of a plan you already have.

> Coaching only. This is not a doctor or a registered dietitian. It will tell you to see a
> professional for injuries, pain, or medical concerns, and it keeps nutrition advice sensible.

<img width="100%" alt="OAK" src="https://github.com/user-attachments/assets/a2d70688-71fa-41ff-a2e2-ba0f947aaba6" />

## What it does

- Chat with your coach in plain language on Telegram, optionally in a configurable persona.
- Send photos and PDFs (a meal, a food label, a gym machine, a progress picture) and it sees them.
- Send a voice note: it is transcribed locally and answered like text (the first voice note
  downloads the Whisper model, ~150 MB, so it is slow once; needs ~1 GB free RAM). Prefer an
  API instead? Set `TRANSCRIBE_PROVIDER=api` to use an OpenAI-compatible endpoint
  (tiny memory footprint, needs a key; see [configuration](./docs/configuration.md)).
- Log workouts conversationally, saved to Notion.
- Ask "what should I train today?" and get a session based on your goals and recent training.
- Get a weekly plan and progress reports written back to Notion as clean, structured pages.
- Look up real exercises (muscles, equipment, demo images) from a free database.
- Nutrition and macro guidance tied to your goals.
- Proactive reminders (morning nudge, Sunday plan, plus any custom reminder you ask for), and
  optionally put planned sessions on your **Google Calendar** with native phone reminders. See
  [docs/google-calendar-architecture.md](./docs/google-calendar-architecture.md).

**Notion is the agent's knowledge base.** The agent creates the Notion databases for you
(Programs, Goals, Body Stats, Workout Log) plus a Dashboard and Knowledge Base page, fills them
with the relevant values as you train, and keeps them up to date, including a live Dashboard that
always reflects your current program, week, goals, latest stats, and next session. Your training
history, programs, goals, and body stats live in this workspace the agent builds and maintains,
and it reads from there before it advises. You can also dump training programs and reference material into the `knowledge/`
folder and ask the coach to import them; it files each into an organised Knowledge Base page in
Notion that it then draws on. See [docs/notion-architecture.md](./docs/notion-architecture.md).

For the full picture see [docs/capabilities.md](./docs/capabilities.md).

## What you need

Before you start, make sure you have:

- **A paid Claude plan (Pro or above).** Oak runs on your Claude subscription through the
  Claude Agent SDK, authenticated with a token from `claude setup-token`. There is no
  metered per-token API billing, but the free tier cannot generate a subscription token,
  so a paid plan is required.
- **A Telegram bot (free).** Created in one minute by messaging
  [@BotFather](https://t.me/BotFather). You will also need your own numeric Telegram user
  id (from [@userinfobot](https://t.me/userinfobot)) so the bot only answers you.
- **A Notion account (the free plan is enough).** Oak talks to Notion through an internal
  integration, which every Notion plan supports, including the free personal plan. You do
  not need a paid workspace, and you do not need to build anything yourself: the agent
  creates and maintains the whole workspace (databases, Dashboard, Knowledge Base) from
  one page you share with the integration.
- **Somewhere to run it.** Your own machine (Node 22+, or Docker) is fine for trying it
  out. For always-on coaching without a machine running at home, deploy scale-to-zero to
  Google Cloud Run or Azure Container Apps; ready-made configs are in
  [`infra/`](./infra/). See [Hosting options](#hosting-options).
- **Optional: a Google account** if you want planned sessions on your calendar with
  native phone reminders (one-time OAuth setup, quickstart step 6).

No fitness tracker, no third-party services, no database to run: state lives in Notion
and in a small gitignored `data/` folder.

## How it works

```
Telegram  <->  grammy bot (src/index.ts)  <->  Claude Agent SDK (src/agent/runner.ts)
                     |                                    |
                scheduler (croner)               Notion (REST API via scripts/notion.mjs)
                reminders + weekly plan          your training log
```

The SDK runs the coach persona in `CLAUDE.md` with the skills in `coach-plugin/`. Your private
goals and stats live in `PERSONAL.md` (gitignored), so the repo stays generic and shareable
while the running agent is personalised to you. More in [docs/architecture.md](./docs/architecture.md).

## Quickstart (local)

1. **Install**
   ```bash
   npm install
   ```

2. **Get a Telegram bot token.** Message [@BotFather](https://t.me/BotFather), send
   `/newbot`, and copy the HTTP API token. Then message [@userinfobot](https://t.me/userinfobot)
   to get your own numeric user id.

3. **Authenticate against your Claude subscription.** This needs the Claude Code CLI and a
   **paid** Claude plan (Pro or above; the free tier cannot generate a token).
   ```bash
   npm install -g @anthropic-ai/claude-code   # if you don't have the `claude` CLI yet
   claude setup-token
   ```
   Copy the `sk-ant-oat01-...` token into `CLAUDE_CODE_OAUTH_TOKEN`. The agent runs on your
   subscription, so there's no metered per-token billing. The bot validates this at startup.

4. **Create a Notion integration.** At
   [notion.com/my-integrations](https://www.notion.com/my-integrations), create an internal
   integration and copy its token. In Notion, open the page you want the coach to work in and
   share it with your integration (Share menu). Copy that page's id (the 32-char hex at the end
   of its URL) into `NOTION_PARENT_PAGE_ID` in `.env`, or into `config/notion-hub.json` (copy
   `config/notion-hub.json.example`); either pins the workspace.

5. **Configure.**
   ```bash
   cp .env.example .env
   cp PERSONAL.md.example PERSONAL.md
   ```
   Fill in `.env` (tokens, your Telegram id, Notion token, optional Google Calendar credentials)
   and `PERSONAL.md` (your goals). Every setting is documented in
   [docs/configuration.md](./docs/configuration.md).

6. **(Optional) Connect Google Calendar.** Lets the coach put planned sessions on your calendar
   with native phone reminders. Create an OAuth "Desktop app" client in
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (enable the
   Calendar API, add yourself as a test user), put its client id/secret in `.env`, then authorise
   once with `node --env-file=.env scripts/google-auth.mjs`. Skip this and calendar sync just
   stays off. See [docs/google-calendar-architecture.md](./docs/google-calendar-architecture.md).

7. **Run it.**
   ```bash
   npm run dev          # live development, loads .env automatically
   # or always-on in Docker:
   docker compose up -d
   ```
   Message your bot `/start`, then `/setup` (or just say "set up my Notion", same thing) to
   build your workspace. Then just talk to it. Only one instance may poll a bot token at once, so do not run local and a deployed
   copy on the same token (you will get a Telegram 409).

### Development

```bash
npm run lint     # Biome: lint + format check
npm run format   # Biome: auto-format
npm run build    # type-check and compile to dist/
npm test         # build, then run the unit tests (node --test)
```

CI runs lint, build, and tests on every push and pull request.

Behavioral evals for the coach persona (tone, safety boundaries, honesty) live in
[`evals/`](./evals/): `python evals/run_evals.py` runs them against the real agent on
your subscription. Run them locally before a release; see [evals/README.md](./evals/README.md).

## Hosting options

Oak can run anywhere Node or a container runs. Three supported paths, from simplest to
most hands-off:

| Option | Cost profile | Reminders | Best for |
|---|---|---|---|
| **Local (dev or Docker)** | Free (your machine) | Built-in scheduler, fires live | Trying it out, tinkering |
| **Google Cloud Run** | Scale-to-zero, typically pennies/month | Cloud Scheduler jobs | Set-and-forget hosting |
| **Azure Container Apps** | Scale-to-zero | Azure cron jobs | Same, on Azure |

- **Local.** `npm run dev` for development, `docker compose up -d` for an always-on
  container. The built-in scheduler (morning nudge, Sunday weekly plan, custom reminders
  you ask for in chat) fires by itself because the process is always running.
- **Google Cloud Run.** Terraform config in [`infra/gcp/`](./infra/gcp/): builds the
  container, wires secrets, and runs the bot in webhook mode so it scales to zero between
  messages. Proactive reminders are driven by Cloud Scheduler jobs instead of the
  in-process scheduler.
- **Azure Container Apps.** Bicep template in [`infra/azure/`](./infra/azure/), same
  webhook + external scheduler model.

One rule regardless of host: **only one instance may poll a bot token at once.** Running
a local copy and a deployed copy on the same token gets you a Telegram 409. Use a second
BotFather bot for local testing if you have a deployed instance.

Full details, including the polling vs webhook trade-off and how scheduled reminders work
in each mode, are in [docs/deployment.md](./docs/deployment.md).

## Commands

- `/start`, `/help`: what the coach can do.
- `/setup`: build the Notion workspace.
- `/today`: today's session. `/plan`: build the week. `/progress`: a report.
- `/log`: log a workout (or just describe it in plain language).
- `/new`: start a fresh conversation, clearing previous context.

## Documentation

| Doc | What's in it |
|---|---|
| [Configuration](./docs/configuration.md) | Every environment variable and what it does. |
| [Capabilities](./docs/capabilities.md) | Skills, vision, voice notes, exercise lookup, personas, reminders. |
| [Architecture](./docs/architecture.md) | Request flow, source layout, scripts, persistence. |
| [Deployment](./docs/deployment.md) | Always-on vs scale-to-zero; Cloud Run and Azure examples. |
| [Notion architecture](./docs/notion-architecture.md) | Workspace schema, build order, API patterns, Dashboard. |
| [Google Calendar architecture](./docs/google-calendar-architecture.md) | OAuth setup, calendar sync, phone reminders for planned sessions. |
| [Customization](./docs/customization.md) | `PERSONAL.md`, `CLAUDE.md`, skills, personas, Notion schema. |

## Make it yours / contributing

This is MIT licensed. Fork it, change the persona, swap the Notion schema, add skills. Keep
`src/` organised by domain and pair new features with focused skills. PRs that keep it generic
and useful to others are welcome. Note: no em dashes in the codebase, please.

## FAQ

**Does this need a paid Notion account?**
No. Internal integrations work on Notion's free plan. The agent builds and maintains the
entire workspace itself; you just create the integration and share one page with it.

**Does it cost anything beyond my Claude subscription?**
Not necessarily. Telegram bots are free, Notion's free plan is enough, and local Whisper
transcription runs on your machine. Cloud hosting scale-to-zero is typically pennies per
month; API transcription (if you opt into `TRANSCRIBE_PROVIDER=api`) is billed by that
provider.

**Can I use an Anthropic API key instead of a subscription?**
Not currently: the bot authenticates with a subscription token from `claude setup-token`
and validates it at startup. A metered API-key mode would be a welcome contribution.

**Do voice notes leave my machine?**
Not by default. Transcription runs locally with Whisper via Transformers.js (first voice
note downloads the ~150 MB model; needs about 1 GB of free RAM). Set
`TRANSCRIBE_PROVIDER=api` only if you prefer a hosted OpenAI-compatible endpoint.

**Does it work with fitness trackers (Garmin, Apple Watch, Whoop)?**
Not out of the box. Oak logs what you tell it and what it reads from Notion. Tracker
integrations would make a good contribution; the skills system in `coach-plugin/` is the
place to add one.

**Can several people use one deployment?**
It is built as a personal coach: one user, one `PERSONAL.md`, one Notion workspace,
answering only your Telegram id. For a partner or friend, run a second instance with its
own bot token and Notion page.

**Is my training data private?**
Your goals and stats live in `PERSONAL.md` (gitignored) and your own Notion workspace;
nothing is sent anywhere except to Anthropic (the model), Notion, Telegram, and, if you
enable them, Google Calendar and the transcription API. The bot also redacts
secret-looking values from anything it echoes.

## Data and acknowledgements

- **Exercise data and demo images:** [free-exercise-db](https://github.com/yuhonas/free-exercise-db)
  by yuhonas, released under [The Unlicense](https://unlicense.org/) (public domain).
- **Voice transcription:** [OpenAI Whisper](https://github.com/openai/whisper) (MIT),
  run locally via [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0).
- **Coaching, programs, goals, and stats** live in your own Notion workspace via the
  Notion API; that data is yours.

## License

MIT. See [LICENSE](./LICENSE).
