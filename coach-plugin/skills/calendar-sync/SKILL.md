---
name: calendar-sync
description: Read and write the user's Google Calendar. Use to check availability before planning, to put planned training sessions on their calendar with phone reminders, and to move or cancel scheduled sessions. This is how the user gets session reminders without relying on Telegram notifications.
---

# Sync training with Google Calendar

The user's calendar is where their real life lives. Use it in two directions: read it so plans fit around actual commitments, and write planned sessions to it so training shows up on their phone with a native reminder. All access goes through `scripts/calendar.mjs` (run via Bash).

## When this applies

- The weekly-plan skill is building or refreshing a week: check the calendar first, write the agreed sessions after.
- The user asks to schedule a session, move one, cancel one, or asks what their week looks like.
- A session was recommended for a specific time today or tomorrow: offer to put it on the calendar (or just do it if they have said they always want that).

If the helper reports Google Calendar is not configured, say so once in plain words ("Calendar sync isn't set up; run `node scripts/google-auth.mjs` when you want sessions on your Google Calendar") and carry on coaching without it. Never fake a sync.

## Commands

```bash
# Is it set up, and which calendar is in use?
node scripts/calendar.mjs status

# Busy blocks for a window (defaults to 7 days from --from). Dates come from
# the Telegram header, never computed internally.
node scripts/calendar.mjs list --from 2026-07-13 --to 2026-07-20

# Create a session. Times without an offset are in the user's TIMEZONE.
# Reminders default to a popup 30 minutes before; override with --reminders
# "popup:60", "popup:30,email:120", "default", or "none".
node scripts/calendar.mjs create --title "Push A (Bench focus)" \
  --start "2026-07-13T18:00" --end "2026-07-13T19:00" \
  --description "Bench 5x5 @62.5kg, OHP 3x8, dips, laterals"

# A stable weekly slot as one recurring event instead of many single ones.
node scripts/calendar.mjs create --title "Training" \
  --start "2026-07-13T18:00" --end "2026-07-13T19:00" \
  --recurrence "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"

# Move or edit (get the id from `list`), or cancel.
node scripts/calendar.mjs update --id <eventId> --start "2026-07-14T18:00" --end "2026-07-14T19:00"
node scripts/calendar.mjs delete --id <eventId>

# Calendar management: keep training on a dedicated calendar if the user
# prefers (creates it when missing and remembers the choice).
node scripts/calendar.mjs list-calendars
node scripts/calendar.mjs use-calendar --name "Training" --create
```

## How to use it well

- **Before planning**: `list` the target week and treat existing events as hard constraints. Do not schedule a session over a meeting or dinner; pick the free slots and say why ("Tuesday 6pm is blocked, so legs move to 7:30pm").
- **After a plan is agreed**: create one event per session in the same turn you write the plan to Notion. Title the event with the session focus, put the key lifts in the description so the user can glance at their phone at the gym, and keep the default 30-minute popup unless they ask otherwise.
- **Finding an event to change**: do not store event ids in your head. `list` the day in question and match by title; ids are printed on every line.
- **Conflicts spotted while chatting**: if the user mentions a new commitment that collides with a planned session, flag it and offer to move the event.
- **Keep Notion and the calendar telling the same story**: when a session moves or is cancelled, update both the Notion plan page and the calendar event, then refresh the Dashboard's Next Session tile if it is affected.
- **Recurring vs individual events**: a stable schedule (same days, same time every week) is one recurring event per slot; a plan that changes weekly is individual events created each week by weekly-plan. Prefer whichever matches how the user actually trains, and do not mix both for the same slot.
- Do not announce every calendar write in detail. One short line ("On your calendar: Mon/Wed/Fri 6pm, reminders 30 min before") is enough.
