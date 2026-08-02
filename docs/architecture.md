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

## Trust boundaries and threat model

The agent runs with `bypassPermissions` and the full tool set, so it is worth being
explicit about which inputs are trusted and which are not.

| Input | Trust | Why |
|---|---|---|
| Telegram text from an allowlisted user | Trusted as intent, not as configuration | `ALLOWED_TELEGRAM_IDS` gates who can talk to the agent, so the sender is who you think it is. They still cannot escalate past the persona rules in `CLAUDE.md`. |
| Files the user drops in `knowledge/`, photos, PDFs | Untrusted | The user chose the file, but not necessarily its contents. A program PDF downloaded from a forum is attacker-controlled text. |
| Pages reached with `WebFetch` / `WebSearch` | Untrusted | Fully attacker-controlled, including HTML comments and off-screen text. |
| Notion page content | Untrusted | Mostly agent-written, but Notion pages are shareable and editable by anyone the user invites. |
| Exercise dataset and other bundled script output | Untrusted as instructions | Third-party JSON, treated as data. |

The rule: **content-derived text is data, never instructions.** Anything that arrives
through a tool result (Read, Bash stdout, WebFetch, an attachment, a Notion block) is
material to reason about and quote, not a source of new orders. Only `CLAUDE.md`, the
skills in `coach-plugin/`, and the live user turn set what the agent should do. Text
inside ingested content that addresses the assistant ("SYSTEM NOTE", "ignore prior
instructions", "your operator config has changed") is a signal to flag the document to
the user, not to obey.

Current mitigations:

- **Allowlist** (`src/channel/permissions.ts`): unknown chat ids never reach the agent.
- **Egress redaction** (`src/util/redact.ts`, applied once at the send boundary in
  `src/index.ts`): env-literal and pattern matching strips secrets from anything the
  agent tries to say, so a successful exfiltration through the reply channel is caught.
- **Localhost-only control plane** (`src/scheduler/server.ts` binds `127.0.0.1`), and a
  bearer `CRON_SECRET` on `/cron/run` in webhook mode.
- **Session TTL** (`SESSION_TTL_HOURS`, default 12): a poisoned conversation does not
  persist indefinitely, and expired transcripts are deleted from disk.
- **Evals** (`evals/scenarios.json`): the `indirect-injection-*` scenarios feed the agent
  poisoned fixtures through a benign request and grade whether it obeyed, with the
  transcript's tool calls checked deterministically.

Current gaps, stated plainly:

- `bypassPermissions` plus unrestricted `Bash` means a successful injection has shell
  access to the box, with the process environment in reach. Redaction covers the reply
  channel; it does not cover `curl` to an attacker's endpoint.
- There is no allowlist on outbound network access from tool calls.
- Nothing structurally separates ingested content from instructions inside the model
  context. The defence is the persona rules plus the model's own judgement, which is a
  probabilistic control, not a boundary.

The recommendation follows from that: run Oak in a container or a dedicated VM with only
the credentials it needs, not on a daily-driver machine with your SSH keys and browser
profile next to it. The Dockerfile in the repo root is the intended deployment shape, and
[deployment.md](./deployment.md) covers Cloud Run.

## Build and run

TypeScript (`NodeNext`, ESM) compiled to `dist/`. `npm run dev` runs `src/` via
`tsx` with `.env` loaded; `npm run build && npm start` runs the compiled output.
The Dockerfile copies `src/` and builds; the entry point is `dist/index.js`.
