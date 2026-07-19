# Contributing to Oak

Thanks for wanting to help. Oak is a personal fitness coach agent, and the goal of every
change is to keep it generic, reliable, and useful to anyone who clones it.

## Before you start

- Open an issue first for anything bigger than a small fix, so we agree on direction
  before you write code.
- Keep it generic: nothing personal (Notion ids, chat ids, goals, tokens) belongs in the
  repo. `PERSONAL.md`, `.env`, `config/notion-hub.json`, and `data/` stay gitignored.

## Code conventions

- Node >= 22, TypeScript, ESM. `src/` is organised by domain (`agent/`, `media/`,
  `scheduler/`, `calendar/`). Put new code in the domain it belongs to; do not grow
  `index.ts`.
- Biome is the formatter and linter. Run `npm run lint` before pushing; CI enforces it.
- No em dashes anywhere (code, docs, prose). Use commas, parentheses, or full stops.
- Helpers that talk to external APIs live in `scripts/` as dependency-free `.mjs` files
  (see `notion.mjs`, `calendar.mjs`) so the agent can drive them via Bash.

## Features and skills

- New agent capabilities ship as a skill under `coach-plugin/skills/<name>/SKILL.md`,
  plus a row in the skills table in `CLAUDE.md`. Keep the two in sync.
- If a skill references a script command, the command must exist. Docs never describe
  flags that are not implemented.
- Anything touching Notion goes through `scripts/notion.mjs`; anything touching Google
  Calendar goes through `scripts/calendar.mjs`. No new direct API clients.

## Tests and docs

- Pair changes with tests where the logic is testable (`npm test`; node:test files live
  in `tests/` and `scripts/*.test.mjs`).
- Update the relevant doc in `docs/` in the same PR: `configuration.md` for new env
  vars, `deployment.md` for infra changes. Mirror infra changes in both `infra/gcp/`
  and `infra/azure/` where applicable.

## Commits and pull requests

- Small, focused PRs with imperative-mood commit subjects ("Add X", "Fix Y") and a body
  explaining why.
- PRs must pass CI (lint, build, tests).
- Persona tweaks and personal-workflow changes belong in your fork; PRs should keep the
  project useful to others.

## Safety boundaries

Oak is a coach, not a doctor. PRs that add medical advice, extreme dieting, or
push-through-pain behaviour will be declined. Nutrition guidance stays sensible and
non-extreme.
