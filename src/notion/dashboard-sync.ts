import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

/**
 * Host-side Dashboard sync.
 *
 * `scripts/notion.ts sync-dashboard` is deterministic (it re-derives the This
 * Week, Goals and Body Stats tiles from the databases), so the host runs it
 * after the reply instead of the model running it inside its turn, where it
 * cost 9 to 17 seconds plus a model round-trip.
 */

// Helper subcommands that add or change rows the three data tiles are built from.
const ROW_WRITE_COMMANDS = new Set(["log"]);

// Matches the helper script argument as .ts (source) or .mjs/.js, with or without a path.
const HELPER_SCRIPT = /(?:^|[\\/])notion\.(?:ts|mjs|js)$/;

/**
 * Splits a shell command into segments (at unquoted ;, &, |, newlines) of
 * arguments with quotes removed, roughly as the shell would hand them to argv.
 * Quote-aware so a "--dry-run" or ";" inside a --set value stays part of that
 * value, exactly as the helper sees it.
 */
function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  const endToken = () => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) token += command[++i];
      else token += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (c === "\\" && i + 1 < command.length) {
      // A backslash-newline is a line continuation, not a separator.
      const next = command[++i];
      if (next === "\r" && command[i + 1] === "\n") i++;
      if (next === "\n" || next === "\r") endToken();
      else {
        token += next;
        inToken = true;
      }
    } else if (/\s/.test(c) && c !== "\n") {
      endToken();
    } else if (c === ";" || c === "&" || c === "|" || c === "\n") {
      endSegment();
    } else {
      token += c;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}

/**
 * What a Bash command does to the Dashboard's data tiles: "dirty" when its last
 * relevant helper call writes rows, "synced" when it is a sync-dashboard call,
 * null when it touches neither. Segments are read in order, so "log && sync"
 * is synced and "sync && log" is dirty. The flag checks mirror the helper's own
 * main(): only a whole "--help" or "--dry-run" argument changes what it does.
 */
export function dashboardSyncEffect(command: string): "dirty" | "synced" | null {
  let effect: "dirty" | "synced" | null = null;
  for (const tokens of shellSegments(command)) {
    const at = tokens.findIndex((t) => HELPER_SCRIPT.test(t));
    if (at === -1) continue;
    const sub = tokens[at + 1];
    const rest = tokens.slice(at + 2);
    if (!sub || rest.includes("--help")) continue;
    if (sub === "sync-dashboard") effect = "synced";
    else if (ROW_WRITE_COMMANDS.has(sub) && !rest.includes("--dry-run")) effect = "dirty";
  }
  return effect;
}

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function localIsoDate(timeZone: string, at: Date = new Date()): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** The subset of a ChildProcess the syncer uses, so tests can pass a fake. */
export interface SyncChild {
  stdout?: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SyncSpawner = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; windowsHide: true },
) => SyncChild;

export interface DashboardSyncer {
  /** Start a sync for this date, or queue one if a sync is already running. Never throws. */
  request(now: string): void;
}

export function createDashboardSyncer(opts: {
  cwd: string;
  spawn?: SyncSpawner;
  timeoutMs?: number;
  log?: (line: string) => void;
}): DashboardSyncer {
  const spawnFn = opts.spawn ?? (nodeSpawn as unknown as SyncSpawner);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const log = opts.log ?? ((line: string) => console.log(line));
  let running = false;
  // At most one queued run: the latest requested date wins, since a sync always
  // re-derives everything from the databases.
  let pending: string | null = null;

  const start = (now: string) => {
    running = true;
    const startedAt = Date.now();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    // error and close can both fire for one child; only the first one counts,
    // or a queued run would start twice.
    const finish = (msg: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      log(`[dashboard] ${msg} (${Date.now() - startedAt}ms)`);
      running = false;
      if (pending !== null) {
        const next = pending;
        pending = null;
        start(next);
      }
    };

    try {
      const child = spawnFn(
        process.execPath,
        [path.join("scripts", "notion.ts"), "sync-dashboard", "--now", now],
        { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      const forward = (chunk: Buffer | string) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) log(`[dashboard] ${line.trim()}`);
        }
      };
      child.stdout?.on("data", forward);
      child.stderr?.on("data", forward);
      // Without an error listener a spawn failure (e.g. ENOENT) would be an
      // uncaught exception and take the bot down.
      child.on("error", (err) => finish(`sync failed: ${err.message}`));
      child.on("close", (code, signal) =>
        finish(code === 0 ? "sync done" : `sync exited with ${code ?? signal}`),
      );
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        // Settle here rather than waiting for close, so a child that ignores
        // the kill can never wedge the queue.
        finish(`sync timed out after ${timeoutMs}ms, killed`);
      }, timeoutMs);
      timer.unref?.();
    } catch (err) {
      finish(`sync failed to start: ${(err as Error).message}`);
    }
  };

  return {
    request(now: string) {
      if (running) {
        pending = now;
        return;
      }
      start(now);
    },
  };
}
