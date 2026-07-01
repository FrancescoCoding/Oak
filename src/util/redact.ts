/**
 * Outbound secret redaction. Every reply leaving the bot passes through
 * redactSecrets() so that even if the model echoes a credential (from a tool
 * result, a file, or the environment), it never reaches the chat.
 *
 * Two strategies, both applied:
 *  1. Literal values of secret-looking env vars (named *TOKEN*, *SECRET*, *KEY*,
 *     etc.) are replaced wherever they appear.
 *  2. Well-known credential formats are matched by pattern, catching secrets read
 *     from files or APIs rather than the environment.
 */

const SECRET_ENV_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|CONNECTION_STRING|AUTH/i;

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted-api-key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted-github-token]"],
  // Notion integration tokens
  [/\b(ntn|secret)_[A-Za-z0-9]{20,}\b/g, "[redacted-notion-token]"],
  // Telegram bot tokens (digits:base64ish)
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "[redacted-telegram-token]"],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]"],
  // Credentials inside connection URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+]*:\/\/[^:/\s@]+):([^@\s]+)@/gi, "$1:[redacted]@"],
  // Bearer tokens in echoed headers or curl output
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, "$1[redacted]"],
  // Private key blocks
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted-private-key]",
  ],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let cachedLiterals: RegExp[] | undefined;

/** Values of secret-looking env vars, longest first so substrings cannot leak. */
function literalSecretPatterns(env: NodeJS.ProcessEnv): RegExp[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (!SECRET_ENV_NAME.test(name)) continue;
    values.push(value);
  }
  return [...new Set(values)]
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(escapeRegExp(v), "g"));
}

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  cachedLiterals ??= literalSecretPatterns(env);
  for (const pattern of cachedLiterals) out = out.replace(pattern, "[redacted]");
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
