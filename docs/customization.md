# Customizing the coach

The repo stays generic; you personalise the running agent through a few files.

## Your profile: `PERSONAL.md`

Copy `PERSONAL.md.example` to `PERSONAL.md` (gitignored) and fill in your goals,
training schedule, available equipment, injuries, and dietary preferences. The
coach reads it before any planning, recommendation, nutrition, or progress task
and honours its constraints (it will not prescribe a barbell session to someone
training with dumbbells, or meals that clash with your diet).

Keep it real, not templated: the coach checks on the first message of a
conversation and will ask you to fill in missing goals and nutrition targets
rather than coach on assumptions.

## The coach's voice and rules: `CLAUDE.md`

`CLAUDE.md` is the persona and the operating rules (tone, safety, Notion
behaviour, formatting). Edit it to change how the coach talks or what it insists
on. It applies to every conversation.

## Skills: `coach-plugin/skills/`

Each skill is a `SKILL.md` with frontmatter (`name`, `description`) and
instructions. The `description` is what triggers the skill, so make it specific.
Add a new skill by creating a folder with a `SKILL.md`; the SDK discovers it
automatically (`skills: "all"`). For deterministic compute, pair a skill with a
small Node CLI in `scripts/` and call it via Bash (see `find-exercises` +
`scripts/exercise-db.mjs` as the template).

## Personas

Persona overlays (`src/agent/personalities.ts`) change only the coach's voice; all
coaching knowledge and the safety rules are preserved, and a persona will drop
character if the user asks.

- **Toggle:** `PERSONALITIES_ENABLED=false` puts everyone on the plain coach.
- **Owner:** the chat in `OWNER_CHAT_ID` always gets Arnold.
- **Everyone else:** a stable random character (Yoda, Sherlock, Tony Stark,
  Gandalf, Dwight Schrute, Jack Sparrow, Batman), chosen deterministically from
  the chat id so it does not change mid-conversation.
- **Add or change characters:** edit `CHARACTER_POOL` (or `ARNOLD`) in
  `src/agent/personalities.ts`; each entry is a `name` and a `voice` instruction.

The startup ping uses the owner's persona name (for example "Arnold is online and
ready").

## Notion schema

The workspace schema is defined in `scripts/setup-workspace.mjs` and documented in
[notion-architecture.md](./notion-architecture.md). Change property names, add a
database, or restyle the Dashboard there; ids are discovered and cached, never
hardcoded, so your changes stay portable.
