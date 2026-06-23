/**
 * Session store keyed by Telegram chat id.
 * Persists to disk so conversations survive process and container restarts.
 * Each chat keeps a single rolling Claude session.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { config } from "../config.js";

interface SessionEntry {
  sessionId: string;
  lastAccessed: number;
}

const SESSION_TTL_MS = config.sessionTtlHours * 60 * 60 * 1000;
const SESSION_FILE = config.sessionFile;

// The Claude Agent SDK writes a JSONL file per session under its project dir:
// ~/.claude/projects/{sanitised-cwd}/{sessionId}.jsonl
// We clean these up when sessions expire to prevent unbounded disk growth.
// The cwd is sanitised by replacing every non-alphanumeric character with a dash,
// matching the SDK's naming convention.
const HOME = process.env.HOME ?? os.homedir();
const SANITISED_CWD = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
const CLAUDE_SESSIONS_DIR = path.join(HOME, ".claude", "projects", SANITISED_CWD);

const sessions = new Map<string, SessionEntry>();

/** Load persisted sessions from disk on startup. */
function loadFromDisk(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      const cutoff = Date.now() - SESSION_TTL_MS;
      let loaded = 0;
      for (const [key, entry] of Object.entries(data)) {
        const e = entry as SessionEntry;
        if (e.lastAccessed >= cutoff) {
          sessions.set(key, e);
          loaded++;
        }
      }
      if (loaded > 0) console.log(`[sessions] Restored ${loaded} sessions from disk`);
    }
  } catch (err) {
    console.warn("[sessions] Failed to load sessions from disk:", (err as Error).message);
  }
}

/** Persist current sessions to disk. */
function saveToDisk(): void {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    const data: Record<string, SessionEntry> = {};
    for (const [key, entry] of sessions) {
      data[key] = entry;
    }
    const tmpFile = SESSION_FILE + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(data), "utf-8");
    fs.renameSync(tmpFile, SESSION_FILE);
  } catch (err) {
    console.warn("[sessions] Failed to persist sessions to disk:", (err as Error).message);
  }
}

// Restore sessions on module load
loadFromDisk();

export function getSession(chatId: string): string | undefined {
  const entry = sessions.get(chatId);
  if (!entry) return undefined;

  if (Date.now() - entry.lastAccessed > SESSION_TTL_MS) {
    sessions.delete(chatId);
    saveToDisk();
    return undefined;
  }

  entry.lastAccessed = Date.now();
  return entry.sessionId;
}

export function setSession(chatId: string, sessionId: string): void {
  sessions.set(chatId, { sessionId, lastAccessed: Date.now() });
  saveToDisk();
}

export function clearSession(chatId: string): void {
  const entry = sessions.get(chatId);
  sessions.delete(chatId);
  saveToDisk();
  if (entry) deleteSessionFiles(entry.sessionId);
}

/** Evict expired sessions and delete their on-disk JSONL files. Called periodically. */
export function evictExpired(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  const toDelete: string[] = [];

  for (const [key, entry] of sessions) {
    if (entry.lastAccessed < cutoff) {
      toDelete.push(key);
    }
  }

  for (const key of toDelete) {
    const entry = sessions.get(key)!;
    sessions.delete(key);
    deleteSessionFiles(entry.sessionId);
  }

  if (toDelete.length > 0) {
    console.log(`[sessions] Evicted ${toDelete.length} expired sessions`);
    saveToDisk();
  }
}

/**
 * Delete the JSONL file (and any associated subdirectory) the SDK wrote for this
 * session. Failures are non-fatal: stale files are just wasted disk, not a
 * correctness issue.
 */
function deleteSessionFiles(sessionId: string): void {
  const jsonlPath = path.join(CLAUDE_SESSIONS_DIR, `${sessionId}.jsonl`);
  try {
    if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);
  } catch (err) {
    console.warn(`[sessions] Could not delete ${sessionId}.jsonl:`, (err as Error).message);
  }

  const dirPath = path.join(CLAUDE_SESSIONS_DIR, sessionId);
  try {
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn(`[sessions] Could not delete session dir ${sessionId}:`, (err as Error).message);
  }
}
