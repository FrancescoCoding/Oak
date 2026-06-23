---
name: find-exercises
description: Look up real exercises by muscle, equipment, or level from a free exercise database. Use when building or recommending a session and you want concrete exercise choices, alternatives for the equipment the user has, a substitute that avoids an injury, or instructions and a demo image for a movement.
---

# Find exercises

Pull real, vetted exercises from a free, keyless database (free-exercise-db, ~870 movements with muscles, equipment, level, instructions, and demo images; public domain, The Unlicense) instead of inventing them. Use it to ground recommendations and weekly plans in actual movements that fit the user's equipment and avoid their injuries.

## How to query

Run the bundled CLI with Bash. Filters are ANDed; muscle matches primary or secondary muscles; equipment/level/category/name match loosely (case-insensitive substring).

```bash
# Compact text (default): name, equipment, level, primary muscles, first cue, demo image
node scripts/exercise-db.mjs --muscle chest --equipment dumbbell --limit 6

# Full records as JSON (all instructions + image URL), use when you need the cues or an image
node scripts/exercise-db.mjs --name "romanian deadlift" --limit 1 --json
```

Flags: `--muscle`, `--equipment`, `--level` (beginner/intermediate/expert), `--category` (strength, cardio, stretching, plyometrics, powerlifting, olympic weightlifting, strongman), `--name`, `--limit` (default 8), `--json`, `--refresh` (force re-download; the dataset is cached for 30 days).

Equipment values in the data: `body only`, `dumbbell`, `barbell`, `kettlebells`, `cable`, `machine`, `bands`, `exercise ball`, `medicine ball`, `e-z curl bar`, `foam roll`, `other`. Map the user's gear in `PERSONAL.md` to these.

## How to use the results

- Always filter to the equipment the user actually has (read `PERSONAL.md`). Do not surface a barbell movement to someone training at home with dumbbells.
- Skip or swap anything that hits an injured area listed in `PERSONAL.md`. If they ask for an alternative to a movement that bothers them, query the same muscle with their equipment and offer 2-3 options.
- Keep the coach's voice: pick a few good movements, give sets/reps/load yourself (grounded in their log), and add the demo images only when they help. Do not dump raw database output on them.
- Every exercise has two demo stills: a **start** and an **end** position (`images.start` and `images.end`). When showing a movement, share both so the user sees the full range, e.g. "start" then "end". They are direct JPG URLs you can post in Telegram.

This skill is a lookup tool. It does not write to Notion. Recommending and logging stay with the recommend-workout, weekly-plan, and log-workout skills.
