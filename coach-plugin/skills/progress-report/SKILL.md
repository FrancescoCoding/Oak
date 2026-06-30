---
name: progress-report
description: Summarise the user's training progress and trends from their logged workouts. Use when the user asks how they are doing, for a progress report, weekly or monthly review, consistency check, or personal records.
---

# Progress report

Turn the Notion Workout Log into an honest, motivating read on how the user is doing.

## 1. Pull the data

- Decide the window from the request (this week, last month, or a sensible default like the last 4 weeks).
- Query the Notion Workout Log with `node scripts/notion.mjs query-recent --db "Workout Log"` for sessions in that window. Read current Goals and `PERSONAL.md` for what success looks like.

## 2. Analyse

- Consistency: sessions completed versus planned or versus their target frequency.
- Volume and load trends on the key lifts (are the numbers moving up?).
- Personal records: any best loads, reps, distances, or times in the window.
- Balance and recovery: any neglected focus areas, or signs of doing too much.
- Progress toward each active goal.

Be truthful. If consistency slipped or a lift stalled, say so kindly and give a concrete fix. Do not invent numbers: if the log is thin, say what is missing and encourage logging.

## 3. Report

Give a short, scannable summary: a headline on how the period went, two or three specifics (a PR, a trend, a gap), and one clear focus for the next stretch. End on genuine encouragement tied to their goal. Keep it phone-friendly.

If the user asks to save the report to Notion, follow the notion-formatting skill so the page is clean and structured: a callout for the headline, H2 sections for consistency, PRs, and what to change, and a column layout with callout tiles for any dashboard-style summary rather than a flat list. If the workspace has a Dashboard page, refresh its tiles afterwards (see notion-formatting).
