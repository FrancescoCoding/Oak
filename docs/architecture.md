# Architecture

How the pieces fit together, and where to find things in the code.

## Request flow

```
Telegram
  │  message / photo / PDF / voice note
  ▼
grammy bot  (src/index.ts)                ── allowlist, dedupe, attachments, transcription
  │
  ├─ voice note ─► local Whisper (src/media/transcribe.ts) ─► text
  │
  ▼
runAgent  (src/agent/runner.ts)            ── Claude Agent SDK query()
  │   • persona overlay (src/agent/personalities.ts)
  │   • session resume   (src/agent/sessions.ts)
  │   • CLAUDE.md persona + coach-plugin skills
  │   • tools: Bash, Read/Write/Edit, Glob/Grep, WebFetch/WebSearch, Skill
  │   • Notion via the REST API (scripts/notion.mjs) run through Bash
  ▼
reply  (src/channel/notify.ts, format.ts)  ── markdown → Telegram HTML, em-dash stripped, secrets redacted

scheduler  (src/scheduler/*)               ── croner fires reminders + the Sunday plan (polling mode)
```

The SDK runs the coach persona in `CLAUDE.md` with the skills in `coach-plugin/`.
Your private goals and stats live in `PERSONAL.md` (gitignored), so the repo stays
generic while the running agent is personalised to you.

## Source layout

`src/` is organised by domain so it scales as features are added:

| Folder | Responsibility |
|---|---|
| `src/index.ts` | Entry point and composition root: wires the bot, scheduler, and HTTP servers. |
| `src/config.ts` | Central env-driven configuration. |
| `src/agent/` | The agent loop (`runner.ts`), persona overlays (`personalities.ts`), and per-chat session store (`sessions.ts`). |
| `src/channel/` | Telegram transport: `notify.ts` (send), `format.ts` (markdown→HTML, em-dash strip), `webhook-server.ts`, `permissions.ts` (allowlist). |
| `src/media/` | Inbound media: `attachments.ts` (images/PDFs → content blocks), `transcribe.ts` (voice notes → text). |
| `src/notion/` | `status.ts` reports whether Notion is configured (a `NOTION_TOKEN` is set). All Notion I/O goes through `scripts/notion.mjs` via Bash. |
| `src/scheduler/` | `scheduler.ts` (croner reminders) and `server.ts` (the localhost control plane). |
| `src/util/` | `redact.ts` (secret scrubbing) and `dedupe.ts` (webhook idempotency). |

## Bundled scripts

`scripts/` holds Node CLIs the agent calls via Bash (the "bundled-CLI" pattern),
plus deploy helpers:

| Script | Purpose |
|---|---|
| `scripts/notion.mjs` | Notion REST helper: `log`, `query-recent`, `append` (rich blocks + columns + inline formatting), `create-page`, `refresh-tile`, `resolve-db`. Retries on rate limits; self-heals a stale id cache. Unit-tested by `scripts/notion.test.mjs` (`npm test`). |
| `scripts/setup-workspace.mjs` | Idempotent builder for the full Notion workspace (databases + Dashboard). See [notion-architecture.md](./notion-architecture.md). |
| `scripts/exercise-db.mjs` | Queries the free, keyless exercise dataset (see [capabilities.md](./capabilities.md)). |
| `scripts/deploy-cloudrun.sh` | Google Cloud Run deploy (see [deployment.md](./deployment.md)). |

## Persistence

- **Sessions / schedule:** JSON files under `data/` (`SESSION_FILE`, `SCHEDULE_FILE`).
- **Notion id cache:** `data/notion-ids.json`, holding resolved database, Hub, Dashboard,
  and tile ids, discovered at setup and reused. No ids are hardcoded in the repo.
- **Notion** is the durable source of truth for training history, programs, goals,
  and stats.

## Build and run

TypeScript (`NodeNext`, ESM) compiled to `dist/`. `npm run dev` runs `src/` via
`tsx` with `.env` loaded; `npm run build && npm start` runs the compiled output.
The Dockerfile copies `src/` and builds; the entry point is `dist/index.js`.
