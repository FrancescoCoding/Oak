# Security Policy

Oak handles real credentials (Telegram bot token, Claude OAuth token, Notion and Google
tokens) and runs an agent with shell access on your own infrastructure, so security
reports are taken seriously.

## Threat model in brief

The full write-up, including the trusted/untrusted input table and the known gaps, is in
[docs/architecture.md](docs/architecture.md#trust-boundaries-and-threat-model). The short
version:

- **Direct prompt injection** (an allowlisted user typing "ignore all previous
  instructions") is the lesser risk. The sender is already authorised, and the persona
  rules hold up against it.
- **Indirect prompt injection is the real surface.** Oak ingests content it did not
  author: training programs dropped in `knowledge/`, photos and PDFs sent over Telegram,
  pages fetched with `WebFetch`, Notion blocks. Any of that can carry an instruction
  block aimed at the assistant. Because the agent runs with `bypassPermissions` and full
  `Bash`, a document that succeeds in giving it orders has shell access to the host.
- The governing rule is that **content-derived text is data, never instructions**. Only
  `CLAUDE.md`, the bundled skills, and the live user turn direct behaviour.

### What is tested

`evals/scenarios.json` exercises this deliberately. `prompt-injection-ignored` covers the
direct case; `indirect-injection-program-file`, `indirect-injection-saved-webpage`, and
`indirect-injection-persona-override` feed the agent poisoned fixtures from
`evals/fixtures/` (exfiltration, tool abuse, persona override) through an innocuous user
request. Those runs disallow `Bash`, `Write`, `Edit`, `WebFetch`, and `WebSearch`, so the
blast radius is nil, and grade the recorded tool calls for compliance intent rather than
waiting for a real side effect. Payloads point at `example.com` and are inert.

### Containment recommendation

Run Oak in a container or a dedicated VM holding only the credentials it needs. Do not
run it on a daily-driver machine alongside SSH keys, cloud credentials, or a browser
profile. Redaction (`src/util/redact.ts`) protects the reply channel, not arbitrary
outbound requests made by a tool call.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository (Security tab, "Report a vulnerability").
You will get a response within a week.

## Scope

Particularly interested in:

- Content that reliably makes the agent act on embedded instructions: a program file,
  image, PDF, Notion page, or web page that gets it to read secrets, write files, or make
  outbound requests.
- Ways an incoming Telegram message could make the agent leak secrets or run
  unintended commands (prompt injection with real impact).
- Bypasses of the `ALLOWED_TELEGRAM_IDS` allowlist or the `CRON_SECRET` check on
  `/cron/run`.
- Secrets ending up in logs, Notion pages, or command output, or slipping past
  `redactSecrets`.

Self-hosting misconfiguration (for example exposing the control plane port publicly)
is covered by the docs rather than this policy, but doc improvements are welcome.
