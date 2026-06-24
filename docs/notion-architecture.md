# Notion workspace architecture

The coaching workspace lives under one root Notion page (the **Hub**, set via
`NOTION_PARENT_PAGE_ID`). Four databases and two pages (a Dashboard and a
Knowledge Base) hang directly off it. The whole thing is built deterministically
by `scripts/setup-workspace.mjs` and maintained through `scripts/notion.mjs`.

Instance-specific ids (Hub, each database, the Dashboard page, and its column
ids) are **not hardcoded** anywhere in the repo. They are discovered at build
time and cached in `data/notion-ids.json` (gitignored). Resolve ids from that
cache or by name lookup, never from a literal in code.

## Build order (strict)

Relations force the order: a database referenced by a relation must exist first.

1. **Programs**
2. **Goals**
3. **Body Stats**
4. **Workout Log** (has a `Program` relation to Programs)
5. an initial Programs row (only if Programs is empty)
6. **Dashboard** page
7. **Knowledge Base** page (where dumped training programs are filed as subpages)

Run it with: `node scripts/setup-workspace.mjs` (idempotent: existing
databases/pages are detected by title and reused, never duplicated). Add
`--rebuild-dashboard` to regenerate the Dashboard body.

## API patterns

- Use the Notion REST API directly (`https://api.notion.com/v1`) for everything;
  it is the only Notion code path. Headers on every request:
  `Authorization: Bearer $NOTION_TOKEN`, `Notion-Version: 2022-06-28`,
  `Content-Type: application/json`. Both helper scripts retry with backoff on
  HTTP 429 (rate limit, approx 3 req/s per integration) and transient 5xx.
- **Columns:** children go *inside* the `column_list` object
  (`{ type:"column_list", column_list:{ children:[...] } }`), and every `column`
  needs at least one child block (an empty paragraph as placeholder). The
  `colList()` helper in `setup-workspace.mjs` and the `::: columns / ||| / :::`
  markdown in `notion.mjs` both enforce this.
- **Pages vs blocks:** `POST /v1/pages` does not nest column children reliably.
  Create the page flat, then `PATCH /v1/blocks/{id}/children` to add content.
  Batch at <=90 blocks per request.
- **Rows:** `POST /v1/pages` with `parent:{ database_id }`. Use
  `node scripts/notion.mjs log --db "Workout Log" --set "Name=value" ...`.
- **Child pages:** `POST /v1/pages` with `parent:{ page_id }`. Use
  `node scripts/notion.mjs create-page --parent <pageId> --title "..." --file x.md`.

## Database schemas

**Programs**: Program (title), Type (select: Powerbuilding, Strength,
Hypertrophy, Cardio, Deload), Status (select: Active, Completed, Planned,
Paused), Start Date (date), End Date (date), Weeks (number), Notes (rich_text).

**Goals**: Goal (title), Category (select: Strength, Body Composition, Cardio,
Habit), Metric (rich_text), Starting Value (number), Current Value (number),
Target Value (number), Target Date (date), Status (select: On track, At risk,
Achieved, Paused).

**Body Stats**: Check-in (title), Date (date), Bodyweight (kg) (number), Waist
(cm) (number), Chest (cm) (number), Arm (cm) (number), Conditions (select:
Morning fasted, Evening, After holiday, Post-training), Notes (rich_text).

**Workout Log**: Session (title), Date (date), Week (select: Week 1-8), Day
(select: Monday, Wednesday, Friday, Saturday, Sunday), Focus (multi_select:
Legs, Chest, Back, Shoulders, Biceps, Triceps, Cardio, Full Body, Mobility),
Status (select: Completed, Partial, Skipped), Top Set (number), Volume (kg)
(number), Duration (min) (number), RPE (1-10) (number), Program (relation to
Programs, single_property).

## Dashboard

A page (not a database), three rows of column layouts:

- Hero: full-width callout (program, week, start date)
- Row 1: 3 columns (This Week, Goals, Body Stats)
- Row 2: 2 columns (Next Session, Active Program + Coach Note)
- Row 3: 2 columns (Nutrition, Quick Commands)

The Row 1 column ids are captured into `data/notion-ids.json` under
`__dashboard.columns` (`thisWeek`, `goals`, `bodyStats`).

### Updating tiles

Never edit blocks in place (ids shift). Replace the whole tile:

```bash
node scripts/notion.mjs refresh-tile --tile goals --md "> [🎯] **Goals**\n- Squat 100kg by Sept"
node scripts/notion.mjs refresh-tile --tile thisWeek --file week.md
node scripts/notion.mjs refresh-tile --tile bodyStats --md "..."
```

## Knowledge Base

A page (not a database) whose id is cached under `__knowledgeBase`. Training
programs the user dumps into the repo's `knowledge/` folder are filed here as
organised subpages (one per program) by the import-knowledge skill, using
`create-page`. The coach draws on these when planning and recommending.

Refresh **Goals** after a goal changes, **bodyStats** after a check-in,
**thisWeek** after a session is logged. Rebuild the whole Dashboard
(`--rebuild-dashboard`) when the program changes, the week advances, or more
than three tiles need updating at once.
