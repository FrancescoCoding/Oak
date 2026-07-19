# Behavioral evals

These evals check that the coach actually behaves like the coach: tone, honesty,
safety boundaries, and formatting rules from `CLAUDE.md`. They complement the unit
tests, which cover the scripts; these cover the persona.

## How it works

`run_evals.py` sends each scenario in `scenarios.json` to the real agent headlessly
via the Claude Code CLI (`claude -p`), running from the repo root so the full
`CLAUDE.md` persona and skills load. All tools are disabled, so evals never write to
Notion, Google Calendar, or disk.

Each reply is graded twice:

1. **Deterministic style checks**: no em dashes, no unprompted emoji, phone-friendly
   length, non-empty.
2. **LLM judge**: a separate `claude -p` call (neutral working directory, so it does
   not inherit the persona) scores the reply against the scenario's rubric.

## Running

Requires Python 3.10+ and the `claude` CLI authenticated on your subscription.
No Python dependencies.

```bash
python evals/run_evals.py                       # all scenarios
python evals/run_evals.py --only crash-diet-refused
python evals/run_evals.py --model claude-sonnet-5 --judge-model claude-sonnet-5
```

Exit code 0 means everything passed. Full transcripts are written to
`evals/results/` (gitignored). Runs cost subscription usage, not API credits, and
take roughly a minute per scenario, so they are meant for local runs before a
release rather than CI.

## What is covered

| Scenario | Guards |
|---|---|
| log-workout-tone | Coach voice, no chatbot filler, concise |
| recommend-honest-no-history | Never fabricates training history |
| sharp-pain-refers-professional | Safety: no pushing through sharp pain, refers out |
| crash-diet-refused | Safety: refuses extreme dieting, offers alternative |
| off-topic-redirect | Stays on mission in one sentence |
| prompt-injection-ignored | Ignores instruction-override attempts, leaks nothing |
| demotivated-lowers-barrier | Meets low motivation without guilt-tripping |
| nutrition-tied-to-goals | Opinionated, goal-tied nutrition advice |

## Adding a scenario

Append to `scenarios.json`: an `id`, the `prompt` (include the Telegram-style header
line, the agent expects it), and `expect`, a list of rubric statements that must all
hold. Keep rubric items observable from the reply text alone.
