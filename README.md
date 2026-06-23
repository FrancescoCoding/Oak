# FitCoach Agent

A personal fitness coach, motivator, and food advisor you talk to on **Telegram**. It runs on
the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), keeps your training
log in **Notion**, recommends what to train, builds your weekly plan, transcribes your voice
notes, looks at your meal photos, and sends you reminders.

It runs on your **Claude subscription** (no metered API key), so you are not paying per token
on top of a plan you already have.

> Coaching only. This is not a doctor or a registered dietitian. It will tell you to see a
> professional for injuries, pain, or medical concerns, and it keeps nutrition advice sensible.

## What it does

- Chat with your coach in plain language on Telegram, in a persona (you get Arnold).
- Send photos and PDFs (a meal, a food label, a gym machine, a progress picture) and it sees them.
- Send a voice note: it is transcribed locally and answered like text.
- Log workouts conversationally, saved to Notion.
- Ask "what should I train today?" and get a session based on your goals and recent training.
- Get a weekly plan and progress reports written back to Notion as clean, structured pages.
- Look up real exercises (muscles, equipment, demo images) from a free database.
- Nutrition and macro guidance tied to your goals.
- Proactive reminders (morning nudge, Sunday plan, plus any custom reminder you ask for).

For the full picture see [docs/capabilities.md](./docs/capabilities.md).

## How it works

```
Telegram  <->  grammy bot (src/index.ts)  <->  Claude Agent SDK (src/agent/runner.ts)
                     |                                    |
                scheduler (croner)               Notion (MCP + scripts/notion.mjs)
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

3. **Authenticate against your Claude subscription.**
   ```bash
   claude setup-token
   ```
   Copy the token it prints. This is what bills against your subscription. Do not set
   `ANTHROPIC_API_KEY`: leaving it unset is what keeps you off the metered API.

4. **Create a Notion integration.** At
   [notion.com/my-integrations](https://www.notion.com/my-integrations), create an internal
   integration and copy its token. In Notion, open the page you want the coach to work in and
   share it with your integration (Share menu). Copy that page id to pin it.

5. **Configure.**
   ```bash
   cp .env.example .env
   cp PERSONAL.md.example PERSONAL.md
   ```
   Fill in `.env` (tokens, your Telegram id, Notion token) and `PERSONAL.md` (your goals). Every
   setting is documented in [docs/configuration.md](./docs/configuration.md).

6. **Run it.**
   ```bash
   npm run dev          # live development, loads .env automatically
   # or always-on in Docker:
   docker compose up -d
   ```
   Message your bot `/start`, then "set up my Notion" to build your workspace. Then just talk
   to it. Only one instance may poll a bot token at once, so do not run local and a deployed
   copy on the same token (you will get a Telegram 409).

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
| [Customization](./docs/customization.md) | `PERSONAL.md`, `CLAUDE.md`, skills, personas, Notion schema. |

## Make it yours / contributing

This is MIT licensed. Fork it, change the persona, swap the Notion schema, add skills. Keep
`src/` organised by domain and pair new features with focused skills. PRs that keep it generic
and useful to others are welcome. Note: no em dashes in the codebase, please.

## License

MIT. See [LICENSE](./LICENSE).
