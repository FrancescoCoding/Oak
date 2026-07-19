# Security Policy

Oak handles real credentials (Telegram bot token, Claude OAuth token, Notion and Google
tokens) and runs an agent with shell access on your own infrastructure, so security
reports are taken seriously.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository (Security tab, "Report a vulnerability").
You will get a response within a week.

## Scope

Particularly interested in:

- Ways an incoming Telegram message could make the agent leak secrets or run
  unintended commands (prompt injection with real impact).
- Bypasses of the `ALLOWED_TELEGRAM_IDS` allowlist or the `CRON_SECRET` check on
  `/cron/run`.
- Secrets ending up in logs, Notion pages, or command output.

Self-hosting misconfiguration (for example exposing the control plane port publicly)
is covered by the docs rather than this policy, but doc improvements are welcome.
