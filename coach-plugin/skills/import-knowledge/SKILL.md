---
name: import-knowledge
description: Import the user's dumped training programs and reference material into the Notion Knowledge Base. Use when the user asks to import their programs, add a program to the knowledge base, or says they have dropped files in the knowledge folder.
---

# Import knowledge into Notion

The user drops raw training programs and reference material into the repo's
`knowledge/` folder (PDF, Markdown, text, images, CSV). Your job is to read them
and file each one as a clean, organised subpage under the Notion **Knowledge
Base** page, so the coach can reference them when planning and recommending.

## 1. Find the unprocessed files and the Knowledge Base page

Only the loose files in `knowledge/` are new. Anything already moved into
`knowledge/processed/` has been imported, so skip it.

```bash
# New files to import (top level only; ignore README.md, .gitkeep, processed/)
find knowledge -maxdepth 1 -type f ! -name README.md ! -name .gitkeep
```

The Knowledge Base page id is cached in `data/notion-ids.json` under
`__knowledgeBase` (created by setup-notion via `scripts/setup-workspace.mjs`). If
it does not exist yet, run setup-notion first. If there are no new files, tell the
user there is nothing to import and stop.

## 2. Read and structure each file

For each program file:

- Read it. For PDFs and images, use your vision to extract the structure (split,
  days, exercises, sets/reps, progression, notes). For Markdown/text/CSV, read
  directly.
- Turn it into clean, structured Markdown: a short summary callout at the top
  (goal, split, days per week, level), then the program laid out with headings per
  day or block and tables or lists for the exercises. Follow the notion-formatting
  skill. Do not invent detail the file does not contain; if a program is partial,
  say so.

## 3. Create the subpage

Create one organised subpage per program under the Knowledge Base page:

```bash
node scripts/notion.mjs create-page \
  --parent "$(node -e "console.log(require('./data/notion-ids.json').__knowledgeBase)")" \
  --title "Push Pull Legs (6 day)" --icon "🏋️" --file /path/to/structured.md
```

Use the file name as the title unless the content gives a clearer one. If a
program with that title already exists, ask whether to replace it rather than
duplicating.

## 4. Move the file to processed

Once a file's subpage is created successfully, move that file into
`knowledge/processed/` so it is not imported again next time the user adds more:

```bash
mkdir -p knowledge/processed
mv "knowledge/<file>" knowledge/processed/
```

Move each file only after its import succeeds. If an import fails, leave the file
in place so it is retried next time. The processed folder is gitignored, so the
raw source is preserved locally without being committed.

## 5. Confirm

Tell the user what you imported (titles), in one short message, and that they can
now reference these programs in planning. The raw files now live in
`knowledge/processed/`; the organised copy is in the Notion Knowledge Base.
