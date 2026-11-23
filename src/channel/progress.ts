/**
 * Progress feedback for long agent runs.
 *
 * A Notion-heavy reply can take a minute or more, and Telegram's typing
 * indicator alone reads as "stuck". For runs that go past a short delay this
 * posts one quiet status message, edits it in place as the run moves between
 * phases, and removes it when the reply lands. Quick runs show nothing.
 *
 * Status text only ever comes from the fixed labels below, never from the
 * command itself, so paths, ids, and anything secret-like cannot leak into it.
 * Set PROGRESS_UPDATES=false to turn the whole thing off.
 */

export interface ActivityEvent {
  tool: string;
  command?: string;
}

/** How the status message reaches the chat. Injected so tests need no Telegram. */
export interface StatusTransport {
  send(text: string): Promise<number>;
  edit(messageId: number, text: string): Promise<unknown>;
  remove(messageId: number): Promise<unknown>;
}

/** On unless PROGRESS_UPDATES is explicitly set to a falsy word. Read per call. */
export function progressUpdatesEnabled(): boolean {
  const raw = (process.env.PROGRESS_UPDATES ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

const GENERIC = "Working on it...";

// Checked in order, first match wins, so a compound command always maps to the
// same label. Writes come before reads: if a command does both, the write is
// the more useful thing to tell the user about.
const COMMAND_LABELS: [RegExp, string][] = [
  // `log` also writes Goals and Body Stats rows, so the label stays neutral. The
  // lookahead stops a future `log-something` subcommand from matching (`\b` would).
  [/\bnotion\.[mc]?[jt]s\s+log(?=\s|$)/, "Saving it to Notion..."],
  [/\bnotion\.[mc]?[jt]s\s+(append|create-page)\b/, "Writing it up in Notion..."],
  [/\bnotion\.[mc]?[jt]s\s+(refresh-tile|sync-dashboard)\b/, "Updating your dashboard..."],
  [/\bsetup-workspace\.[mc]?[jt]s\b[^\n]*--rebuild-dashboard/, "Updating your dashboard..."],
  [/\bsetup-workspace\.[mc]?[jt]s\b/, "Setting up your Notion workspace..."],
  [/\bnotion\.[mc]?[jt]s\s+(query-recent|get-page-blocks)\b/, "Checking your training log..."],
  [/\bnotion\.[mc]?[jt]s\s+(resolve-workspace|resolve-db)\b/, "Opening your Notion workspace..."],
  [/\bnotion\.[mc]?[jt]s\b/, "Working in Notion..."],
  [/\bcalendar\.[mc]?[jt]s\s+(create|update|delete)\b/, "Updating your calendar..."],
  [/\bcalendar\.[mc]?[jt]s\b/, "Checking your calendar..."],
  [/\bexercise-db\.[mc]?[jt]s\b/, "Looking up exercises..."],
];

// Skill names may arrive plugin-prefixed ("coach-plugin:weekly-plan").
const SKILL_LABELS: Record<string, string> = {
  "log-workout": "Logging your session...",
  "recommend-workout": "Working out today's session...",
  "weekly-plan": "Putting your week together...",
  "progress-report": "Going through your progress...",
  "nutrition-advice": "Working out the food side...",
  "find-exercises": "Looking up exercises...",
  "calendar-sync": "Checking your calendar...",
  "import-knowledge": "Filing your programs into Notion...",
  "setup-notion": "Setting up your Notion workspace...",
};

/**
 * The status label for one tool call, or null when the call says nothing new
 * (reading a file, an unrecognised shell command) and the current label should stay.
 */
export function describeActivity(event: ActivityEvent): string | null {
  const command = event.command ?? "";
  if (event.tool === "Bash") {
    for (const [pattern, label] of COMMAND_LABELS) {
      if (pattern.test(command)) return label;
    }
    return null;
  }
  if (event.tool === "Skill") {
    const name = command.split(":").pop()?.trim() ?? "";
    return SKILL_LABELS[name] ?? null;
  }
  if (event.tool === "WebSearch" || event.tool === "WebFetch") return "Looking that up...";
  return null;
}

const noop = () => {};

export class ProgressReporter {
  private label: string | null = null; // latest phase seen
  private shown: string | null = null; // what the status message currently says
  private messageId: Promise<number | undefined> | null = null;
  // Every Telegram call goes through this chain, so an edit or delete always
  // runs after the send that created the message, even if it was still in flight.
  private ops: Promise<unknown> = Promise.resolve();
  private visible = false;
  private finished = false;
  private lastPostAt = 0;
  private readonly delayTimer: ReturnType<typeof setTimeout>;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly minEditMs: number;

  constructor(
    private readonly transport: StatusTransport,
    opts: { delayMs?: number; minEditMs?: number } = {},
  ) {
    this.minEditMs = opts.minEditMs ?? 4000;
    this.delayTimer = setTimeout(() => {
      this.visible = true;
      this.flush();
    }, opts.delayMs ?? 9000);
  }

  /** Feed one tool call from the run. Never throws. */
  onActivity(event: ActivityEvent): void {
    try {
      if (this.finished) return;
      this.label = describeActivity(event) ?? this.label ?? GENERIC;
      if (this.visible) this.flush();
    } catch (err) {
      console.warn("[progress] activity handling failed:", (err as Error).message);
    }
  }

  /**
   * Stop updating straight away and remove the status message if one was posted.
   * The stop is synchronous, so calling this before sending the reply guarantees
   * no status lands after it; the returned promise settles once the delete is done.
   */
  finish(): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.finished = true;
    clearTimeout(this.delayTimer);
    if (this.editTimer) clearTimeout(this.editTimer);
    return this.withMessage((id) => this.transport.remove(id));
  }

  private flush(): void {
    if (this.finished || !this.label || this.label === this.shown) return;
    const text = this.label;

    if (!this.messageId) {
      this.shown = text;
      this.lastPostAt = Date.now();
      this.messageId = this.queue(() => this.transport.send(text)).catch(() => undefined);
      return;
    }

    // Rate-limit edits; a burst of phase changes collapses into one trailing edit.
    const wait = this.lastPostAt + this.minEditMs - Date.now();
    if (wait > 0) {
      this.editTimer ??= setTimeout(() => {
        this.editTimer = null;
        this.flush();
      }, wait);
      return;
    }
    this.shown = text;
    this.lastPostAt = Date.now();
    void this.withMessage((id) => this.transport.edit(id, text));
  }

  private queue<R>(op: () => Promise<R>): Promise<R> {
    const result = this.ops.then(op);
    this.ops = result.then(noop, noop);
    return result;
  }

  /** Queue an operation on the posted status message; a no-op if none was posted. */
  private withMessage(op: (id: number) => Promise<unknown>): Promise<void> {
    const pending = this.messageId;
    if (!pending) return Promise.resolve();
    return this.queue(async () => {
      const id = await pending;
      if (id !== undefined) await op(id);
    }).then(noop, (err) => console.warn("[progress] status update failed:", err?.message));
  }
}
