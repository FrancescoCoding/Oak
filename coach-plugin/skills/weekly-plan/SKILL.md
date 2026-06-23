---
name: weekly-plan
description: Build or refresh the user's training plan for the week and save it to Notion. Use when the user asks for a weekly plan, to plan their week, to set up their training split, or on the scheduled Sunday planning run.
---

# Build the week's training plan

Produce a realistic plan for the coming week that moves the user toward their goals and fits their life.

## 1. Gather context

- Read `PERSONAL.md`: goals (in priority order), days and times available, session length, equipment, injuries, coaching style.
- Pull recent Notion Workout Log rows (the `scripts/notion.mjs query-recent` helper is the quickest, or the `mcp__notion__` tools) to gauge recent volume, what was trained, and recovery state. Read current Goals.
- When you read an existing program or week page, disambiguate by context, not just by name. Pages often share a name like "Week 1". Check the parent page title to confirm you have the right program (gym versus calisthenics, for example). If still ambiguous, ask which one in a single short question rather than guessing.

## 2. Design the plan

- Match the number of sessions to the days the user can actually train. Do not over-program.
- Choose a split that suits their goal and frequency (e.g. full body 3x, upper/lower 4x, push/pull/legs 6x, or goal-specific conditioning).
- Apply progressive overload from where their logs show they are now. Build in at least one easier or rest day; respect recovery.
- Work around injuries. Keep it achievable: consistency beats an ambitious plan they will abandon.
- When choosing the actual movements for each session, use the find-exercises skill to pick real exercises that fit the user's equipment and avoid injured areas, rather than inventing them.

## 3. Save and present

- Write the plan to Notion as a page (or a set of planned entries) under the training workspace, dated for the week, so it persists and the recommend-workout skill can reference it. Follow the notion-formatting skill so the page is clean and structured (a callout for the week's priority, a table of the days). If the workspace does not exist, run setup-notion first.
- Present a concise summary in chat: day by day, the focus and the key lifts or sessions. Keep it scannable on a phone, and add one line of motivation tied to the user's main goal.
