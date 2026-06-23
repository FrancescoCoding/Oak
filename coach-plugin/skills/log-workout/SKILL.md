---
name: log-workout
description: Record a workout the user did into the Notion Workout Log. Use whenever the user tells you what they trained, e.g. "did 5x5 squats at 80kg", "logged a 5k run", "finished push day", or "log my session".
---

# Log a workout

Turn what the user says into a clean row in the Notion Workout Log.

## 1. Parse the session

From the user's message, extract:

- What they did (exercises with sets, reps, and load; or the activity and distance/time for cardio).
- A short session name and a Focus category (Push, Pull, Legs, Upper, Lower, Full body, Cardio, Mobility, Rest).
- Duration and RPE only if the user stated them.
- Any notes the user actually said ("felt strong", "left knee tight").

**Log only what the user explicitly stated.** No interpolation, no assumptions, no narrative. If the user did not mention RPE, duration, how it felt, or notes, leave those fields blank. Never write invented detail into the Notes field (for example "back felt fine, stopped early" when the user never said that). The one allowed exception is a neutral fact you can derive from what they said (for example "partial session" when they said they had to leave early), kept to one sentence with nothing embellished.

**Date.** Do not set a date unless you are sure the session is real and you know when it happened. Default to today (from the Telegram message header timestamp, not your own day reasoning) only when the user says "just now", "today", or similar, or has clearly just trained. If they say "yesterday", "Monday", etc., use that. If it is unclear whether the session is real or a test, ask one question first: "Did you actually do this today, or are we testing?" and only set a date once confirmed.

If a key detail is genuinely ambiguous, ask one short question. Do not interrogate: it should be faster to log with you than with a spreadsheet.

## 2. Write to Notion

**Log to the main Workout Log, never a per-week database.** The canonical target
is the top-level Workout Log database in the user's training workspace. Resolve
its id once with `node scripts/notion.mjs resolve-db --name "Workout Log"` (it is
cached afterwards) and reuse it. Program pages often embed their own per-week log
databases (for example a "Gym Log" table inside a "Week 1" page); those belong to
the program structure and are not the coach's logging target. Do not write the
user's sessions there. If a search returns several candidates, pick the one whose
parent is the main training/workspace page, not a week or program page.

Add a row to the Workout Log database with the bundled helper, which writes
directly to the database (the Notion MCP post-page tool cannot target a database
parent, so prefer the helper for logging):

```bash
node scripts/notion.mjs log --db "Workout Log" \
  --set "Session=Push A" --set "Focus=Chest, Shoulders, Triceps" \
  --set "Date=2026-06-23" --set "Status=Completed" \
  --set "Top Set=60" --set "RPE (1-10)=8" --set "Duration (min)=55"
```

The helper reads the database schema and coerces each `--set` to the right
property type (title, select, multi_select, date, number). Property names must
match the database exactly (see `docs/notion-architecture.md`); if you get one
wrong the helper fails and prints the real property names, so use that to correct
yourself. Only set properties the user actually gave you; leave the rest out.

The Workout Log has no free-text exercises property, so put the per-lift
breakdown in the row's page body with `append` (using the row id the `log`
command prints), one line per lift as "Squat 5x5 @80kg; RDL 3x8 @70kg".

If the Workout Log database does not exist, run the setup-notion skill first, then log.

If the user flags an injury or pain while logging (not normal training soreness), note it and gently raise it: suggest backing off and seeing a professional if it is sharp, persistent, or worrying.

## 3. Confirm and encourage

Reply with a short confirmation of what you logged and a genuine, specific bit of encouragement or a note on progress if you can see it (for example "that is 5kg up on last week's squat"). Keep it to a sentence or two.
