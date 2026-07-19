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

**Aim for a complete row.** A good coach keeps a complete log, so try to fill every property the schema has (Session, Date, Week, Day, Focus, Status, Top Set, Volume, Duration, RPE, Program), in two steps:

1. **Derive what is derivable, without asking.** Day follows from the Date. Program and Week come from the active program (Programs database or Dashboard hero); if there is one active program, link it. Volume is computable when the user gave a full breakdown (sum of sets x reps x load). Top Set is the heaviest load they stated. Status is Completed unless they said otherwise. These are facts, not guesses.

2. **Ask once about the rest.** If fields are still missing after deriving (typically RPE, duration, sometimes a load they skipped), ask for them once, bundled into a single short question: "Quick fill-in so the log is complete: how hard out of 10, and roughly how long?" One message, not one question per field. If the user answers, log it; if they say they do not know, do not remember, or just ignore the question, log without those fields and move on. Never ask twice about the same field for the same session, and never let the missing fields delay or block the logging itself.

**Never fabricate.** A blank field is always better than an invented value. No interpolation, no assumptions, no narrative. Never write invented detail into the Notes field (for example "back felt fine, stopped early" when the user never said that). The one allowed exception is a neutral fact you can derive from what they said (for example "partial session" when they said they had to leave early), kept to one sentence with nothing embellished.

**Date.** Do not set a date unless you are sure the session is real and you know when it happened. Default to today (from the Telegram message header timestamp, not your own day reasoning) only when the user says "just now", "today", or similar, or has clearly just trained. If they say "yesterday", "Monday", etc., use that. If it is unclear whether the session is real or a test, ask one question first: "Did you actually do this today, or are we testing?" and only set a date once confirmed. Fold this into the same single fill-in question if you are asking one anyway.

If a key detail is genuinely ambiguous, resolve it in that same single question. Do not interrogate: it should be faster to log with you than with a spreadsheet.

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
directly to the database through the Notion REST API:

```bash
node scripts/notion.mjs log --db "Workout Log" \
  --set "Session=Push A" --set "Focus=Chest, Shoulders, Triceps" \
  --set "Date=2026-06-23" --set "Day=Monday" --set "Week=Week 2" \
  --set "Status=Completed" --set "Program=Current Program" \
  --set "Top Set=60" --set "Volume (kg)=4200" \
  --set "RPE (1-10)=8" --set "Duration (min)=55"
```

The helper reads the database schema and coerces each `--set` to the right
property type (title, select, multi_select, date, number, relation). For the
Program relation, pass the program row's title (or its page id); the helper looks
it up in the related database. Property names must match the database exactly
(see `docs/notion-architecture.md`); if you get one wrong the helper fails and
prints the real property names, so use that to correct yourself. Set every
property you know or derived; leave out only what remains genuinely unknown
after the one fill-in question.

The Workout Log has no free-text exercises property, so put the per-lift
breakdown in the row's page body with `append` (using the row id the `log`
command prints), one line per lift as "Squat 5x5 @80kg; RDL 3x8 @70kg".

If the Workout Log database does not exist, run the setup-notion skill first, then log.

If the user flags an injury or pain while logging (not normal training soreness), note it and gently raise it: suggest backing off and seeing a professional if it is sharp, persistent, or worrying.

## 3. Keep the Dashboard current

Do both of these in the same turn, before replying:

1. Run `node scripts/notion.mjs sync-dashboard --now <YYYY-MM-DD from the Telegram header>` to re-derive the This Week, Goals, and Body Stats tiles from the databases.
2. Refresh the **Next Session** tile. The session just logged is no longer "next": work out what actually comes next from the weekly plan (or the active program's schedule) and rewrite the tile with `node scripts/notion.mjs refresh-tile` (tile ids in `data/notion-ids.json` under `__dashboard.columns`; content format in the notion-formatting skill). If no plan tells you what is next, put a short honest placeholder ("Next session not planned yet, ask me to plan the week") rather than leaving the completed session showing.

`sync-dashboard` alone is not enough: it does not touch the prose tiles, and a Next Session tile still showing the workout that was just logged is exactly the staleness to avoid.

## 4. Confirm and encourage

Reply with a short confirmation of what you logged and a genuine, specific bit of encouragement or a note on progress if you can see it (for example "that is 5kg up on last week's squat"). Keep it to a sentence or two.
