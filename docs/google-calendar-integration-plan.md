# Google Calendar Integration Plan

Status: **implemented**. See `docs/google-calendar-architecture.md` for the
finished shape (auth flow, scopes, script commands, data flow) and
`coach-plugin/skills/calendar-sync/SKILL.md` for how the agent uses it.

Notable decisions made during implementation:

- No `googleapis` dependency: the helper (`scripts/calendar.mjs`) uses plain
  `fetch` against the REST API, matching `scripts/notion.mjs`.
- Refresh token comes from `data/google-token.json` (written once by
  `scripts/google-auth.mjs`, loopback OAuth flow) or the
  `GOOGLE_REFRESH_TOKEN` env var for secret-store deployments.
- Default calendar is `primary`; a dedicated calendar is opt-in via
  `calendar.mjs use-calendar --name "Training" --create` or
  `GOOGLE_CALENDAR_ID`.
- Created events default to a 30-minute popup reminder, and recurring weekly
  slots are supported via `--recurrence` (RRULE), so calendar notifications
  fully replace Telegram nudges for session reminders.
- Event ids are not persisted in Notion: the agent lists the day's events and
  matches by title when it needs to update or cancel one (stateless, no drift).
