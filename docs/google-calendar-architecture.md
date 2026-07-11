# Google Calendar Integration

How the coach reads and writes the user's Google Calendar. The purpose is
twofold: plans fit around real commitments, and planned sessions land on the
user's phone with **native calendar reminders**, so nobody has to rely on
Telegram notifications for session nudges.

The integration mirrors the Notion one (`docs/notion-architecture.md`): a thin
REST helper script run via Bash, config-driven credentials, graceful
degradation when unconfigured, and a skill (`coach-plugin/skills/calendar-sync/`)
that tells the agent when and how to use it. There is no MCP server and no SDK
dependency: OAuth2 refresh is one POST and the Calendar API is plain JSON over
REST, so `fetch` covers it (the plan originally suggested the `googleapis`
package; it was dropped as ~100MB of dependency for four endpoints).

## Auth

OAuth2 for installed apps, set up once:

1. In Google Cloud Console: create a project, enable the **Google Calendar
   API**, configure the OAuth consent screen (External; add yourself as a test
   user, no publishing needed), and create an OAuth client of type **Desktop
   app**.
2. Put the client id and secret in `.env` as `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`.
3. Run `node --env-file=.env scripts/google-auth.mjs`. It starts a loopback
   server on 127.0.0.1, prints the consent URL, receives the redirect,
   exchanges the code, and writes `data/google-token.json` (gitignored, same
   trust tier as `data/notion-ids.json`).

Scope is `https://www.googleapis.com/auth/calendar` (full, not `.events`) so
the agent can also create a dedicated training calendar.

At runtime `scripts/calendar.mjs` mints short-lived access tokens from the
refresh token, caches them in the token file with their expiry, refreshes when
within a minute of expiring, and forces one re-mint on a 401. Requests retry
with backoff on 429/5xx, same tuning as `notion.mjs`.

Refresh token resolution order: `GOOGLE_REFRESH_TOKEN` env var (deployments:
store the `refresh_token` field from the token file in Secret Manager), then
`data/google-token.json` (path overridable with `GOOGLE_TOKEN_FILE`, e.g.
`/data/google-token.json` on a mounted volume).

`googleCalendarConfigured()` in `src/calendar/status.ts` gates the feature:
client id + secret + a refresh token from either source. When false, the bot
runs fine and the session context tells the model calendar sync is off.

## Calendar selection

First match wins:

1. `GOOGLE_CALENDAR_ID` env var,
2. the id cached in `data/google-calendar.json` by
   `calendar.mjs use-calendar --name "Training" [--create]` (find-or-create by
   name, mirrors the Notion resolve-by-name pattern),
3. `primary`.

## The helper: scripts/calendar.mjs

```bash
node scripts/calendar.mjs status                       # configured? which calendar?
node scripts/calendar.mjs list --from 2026-07-13 [--to 2026-07-20] [--limit 50]
node scripts/calendar.mjs create --title "Push A" \
     --start "2026-07-13T18:00" --end "2026-07-13T19:00" \
     [--description ...] [--location ...] \
     [--reminders "popup:30"] [--recurrence "RRULE:FREQ=WEEKLY;BYDAY=MO,TH"]
node scripts/calendar.mjs update --id <eventId> [--title|--start|--end|--description|--reminders ...]
node scripts/calendar.mjs delete --id <eventId>
node scripts/calendar.mjs list-calendars
node scripts/calendar.mjs use-calendar --name "Training" --create
```

Conventions:

- **Times**: `YYYY-MM-DD` makes an all-day event; `YYYY-MM-DDTHH:MM[:SS]`
  without an offset is interpreted in `TIMEZONE` (the agent's configured tz);
  an explicit `Z`/`±hh:mm` offset is passed through untouched.
- **Reminders**: created events default to a popup 30 minutes before (this is
  the Telegram-free nudge). `--reminders` accepts `popup:30`,
  `popup:30,email:120`, `default` (calendar's defaults), or `none`.
- **Recurrence**: `--recurrence` takes a single RRULE, for stable weekly slots.
- `list` prints one line per event including its id, which is how the agent
  finds an event to `update`/`delete` (list-then-match by title; no id store).
- `--from`/`--to` dates come from the Telegram message header, never from
  internal date computation.

## Data flow for weekly planning

1. `weekly-plan` reads Notion (Programs/Goals/Workout Log) as before.
2. It lists the target week's calendar events and treats them as hard
   constraints when picking session slots.
3. The plan is written to Notion (unchanged), then one calendar event is
   created per session: focus in the title, key lifts in the description,
   30-minute popup reminder.
4. When a session moves or is cancelled, both the Notion plan page and the
   calendar event are updated, and the Dashboard's Next Session tile is
   refreshed if affected.

## Testing

- `scripts/calendar.test.mjs` unit-tests the pure logic (time parsing,
  reminder specs, event body building, list windows, formatting); no network.
- Manual smoke test: `node scripts/google-auth.mjs`, then
  `node scripts/calendar.mjs status` and a `list` round-trip.
