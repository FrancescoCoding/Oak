---
name: recommend-workout
description: Recommend the user's training session for today, or start a session. Use when the user asks what to train, what today's workout is, to start a session, or for a quick session because they are short on time.
---

# Recommend today's session

Give the user a concrete session they can start now, grounded in their goals and what they have actually been doing.

## 0. First-message profile check

On the first message of a new conversation, check that `PERSONAL.md` has real goals and a nutrition target, not placeholder or example text. If it is still thin or templated, do not coach around the gap: ask one short pair of questions first, for example "Before we start, your profile is missing goals and nutrition targets. What are you training towards, and roughly what do you eat day to day?" Then update `PERSONAL.md` with the answers before giving the session.

## 1. Gather context

- Read `PERSONAL.md` for goals, schedule, available equipment, injuries, and coaching style. Honour the equipment and injury constraints strictly.
- Take the current day and time only from the Telegram message header, in the form `[local time: DD/MM/YYYY, HH:MM:SS (timezone)]`. Never work out the day of the week yourself from the date or from memory; the header is the source of truth.
- When reading a program or plan from Notion, disambiguate by context, not just by name. Many pages share a name like "Week 1". Before using one, check its parent page title to confirm it is the right program (for example a gym program versus a calisthenics program). If it is still ambiguous, show the two candidates and ask which one in a single short question, not a dump of every search result.
- Pull recent rows from the Notion Workout Log before recommending anything. The fastest path is the bundled helper, which queries and sorts for you:

  ```bash
  # Last 3 sessions overall, or for a specific Focus you are about to train
  node scripts/notion.mjs query-recent --db "Workout Log" --limit 3
  node scripts/notion.mjs query-recent --db "Workout Log" --focus Push --limit 3
  ```

  Use the returned loads and RPE as the reference point for today's prescription. The helper is one call and already sorted by date. Check the current week's plan if one exists.

## 2. Decide the session

Apply basic training sense:

- Respect recovery: do not recommend heavy work on a muscle group trained hard yesterday. Rotate focus sensibly.
- Move toward the user's priority goal (progressive overload on the key lifts, or the conditioning the goal needs).
- Fit the time and equipment they actually have. If they say they are short on time, give a tight, high-value version.
- Work around any injury or limitation in `PERSONAL.md`.

## 3. Deliver it

Give a clear, ready-to-do session:

- A short warm-up.
- The main work: exercises with sets, reps, and a load or intensity cue (use recent log loads as the reference point, suggesting a sensible progression). When you want concrete movements that fit their equipment, or an alternative that avoids an injury, use the find-exercises skill to look them up rather than inventing them.
- An optional finisher if time allows.

Keep it phone-friendly and motivating. End with a nudge to log it when done (the log-workout skill will record it). Do not write this recommendation to Notion unless the user asks: it is a suggestion until they actually do and log it.
