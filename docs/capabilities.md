# Capabilities

What the coach can do, in depth. Behaviour lives in the persona (`CLAUDE.md`) and
the skills under `coach-plugin/skills/`; supporting compute lives in `scripts/`.

## Coaching skills

Skills are invoked automatically when a message matches; you rarely call them by
name.

| Skill | What it does |
|---|---|
| `setup-notion` | Builds the full Notion workspace (Programs, Goals, Body Stats, Workout Log, Dashboard) idempotently. |
| `log-workout` | Records a session to the Workout Log. Logs only what you actually said; never invents RPE, notes, or dates; asks "real or testing?" when a session's reality is unclear. |
| `recommend-workout` | Suggests today's session, grounded in your goals and the last sessions pulled from Notion. Checks `PERSONAL.md` on the first message and asks for missing goals/nutrition before coaching on assumptions. |
| `weekly-plan` | Builds the week's plan from goals and recent volume, written to Notion. |
| `nutrition-advice` | Food, macros, and meal guidance tied to your goals. |
| `progress-report` | Consistency, volume trends, and personal records, optionally saved as a formatted Notion page. |
| `find-exercises` | Looks up real exercises (see below). |
| `notion-formatting` | How to write clean, structured Notion pages and keep the Dashboard in sync. |
| `import-knowledge` | Imports dumped training programs into the Notion Knowledge Base (see below). |

Cross-cutting coaching rules (disambiguate Notion pages by parent context, read
the day from the Telegram header, never use em dashes, etc.) are baked into these
skills and `CLAUDE.md`.

## Vision: photos and PDFs

Send a meal, a food label, a gym machine, or a progress picture. Images and PDFs
are turned into model content blocks (`src/media/attachments.ts`) so the coach can
read a label, estimate a meal, identify a movement, or comment on a setup, then
tie it back to your goals.

## Voice notes

Telegram voice notes are transcribed and treated as if you had typed them. The
provider is configurable via `TRANSCRIBE_PROVIDER`:

- `local` (default): Whisper runs in-process (OGG/Opus decoded with bundled
  `ffmpeg-static`, transcribed via Transformers.js). Free, private, no key, no
  audio leaves the machine, but it needs a lot of RAM, so it suits self-hosting.
- `api`: the audio is transcoded and sent to an OpenAI-compatible transcription
  endpoint (OpenAI `gpt-4o-transcribe` by default). Tiny memory, needs a key, the
  right choice for scale-to-zero deployments where running Whisper would force a
  large instance.
- `off`: voice notes are declined with a "type it out" reply.

## Exercise database

The `find-exercises` skill pulls real movements from the free, keyless
[free-exercise-db](https://github.com/yuhonas/free-exercise-db) dataset (~870
exercises with muscles, equipment, level, instructions, and start/end demo
images), released under The Unlicense (public domain). `scripts/exercise-db.mjs` downloads and caches the dataset, then filters:

```bash
node scripts/exercise-db.mjs --muscle chest --equipment dumbbell --limit 6
node scripts/exercise-db.mjs --name "romanian deadlift" --json
```

It honours your equipment and injuries from `PERSONAL.md` and can share both the
start and end demo image for a movement.

## Notion tooling

The agent talks to Notion entirely through its REST API via `scripts/notion.mjs`
(there is no MCP server): logging rows, querying recent sessions, writing rich
blocks (headings, callouts, dividers, tables, columns, with inline bold/italic/
code/links), creating pages, and refreshing Dashboard tiles. The helper retries
automatically on Notion's rate limit and self-heals its local id cache if a
database is deleted and recreated. The full workspace schema, build order, API
patterns, and Dashboard layout are in
[notion-architecture.md](./notion-architecture.md).

## Knowledge base

Notion doubles as the agent's knowledge base. Drop training programs and reference
material (PDF, Markdown, text, images, CSV) into the repo's `knowledge/` folder and
ask the coach to import them. The `import-knowledge` skill reads each file,
structures it (using vision for PDFs and images), and files it as an organised
subpage under a **Knowledge Base** page in Notion via
`scripts/notion.mjs create-page`. The raw dump stays local and gitignored; the
durable, organised copy lives in Notion, and the coach draws on it when planning.

## Personas

Persona overlays change the coach's voice without touching its knowledge or safety
rules. The owner gets Arnold; other chats get a stable random famous character.
See [customization.md](./customization.md) to configure or extend them.

## Reminders

A scheduler can message you proactively (a morning nudge, the Sunday plan, plus any
custom reminder you ask for in chat). Management is live in polling mode; in
webhook mode an external scheduler runs the jobs. See
[deployment.md](./deployment.md) and [configuration.md](./configuration.md).
