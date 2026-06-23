# Knowledge dump

Drop your training programs and reference material here (PDF, Markdown, text,
images of a plan, a coach's spreadsheet exported to CSV, whatever you have). Then
ask the coach to "import my programs" and it reads everything in this folder and
files it into an organised **Knowledge Base** page in Notion, one subpage per
program, which it then references when planning and recommending.

You only dump raw files here; the organised, durable copy lives in Notion. After a
file is imported, the coach moves it into `knowledge/processed/` so it is not
ingested again when you drop more files in later. To re-import something, move it
back out of `processed/`.

## Notes

- The contents of this folder are **gitignored** on purpose, so your personal
  programs and notes are never committed. Only this README and `.gitkeep` are
  tracked, to keep the folder in the repo.
- Give files clear names (for example `ppl-6day.pdf`, `5x5-strength.md`); the
  coach uses the file name as the program title unless the content says otherwise.
- Large or messy files are fine; the coach summarises and structures them when
  importing.
