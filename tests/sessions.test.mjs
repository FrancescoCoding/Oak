import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

// sessions.js snapshots the TTL and the file path from config at import time, so
// config is mocked with getters and a fresh module instance is loaded per test
// (via a cache-busting query) whenever a different TTL or file is needed.
// Requires --experimental-test-module-mocks (set on the npm test script).
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-sessions-"));

let sessionFile = path.join(TMP_DIR, "sessions.json");
let sessionTtlHours = 12;

mock.module("../dist/config.js", {
  namedExports: {
    config: {
      get sessionFile() {
        return sessionFile;
      },
      get sessionTtlHours() {
        return sessionTtlHours;
      },
    },
  },
});

let instance = 0;
async function loadSessions(opts = {}) {
  sessionFile = path.join(TMP_DIR, `sessions-${++instance}.json`);
  sessionTtlHours = opts.ttlHours ?? 12;
  if (opts.seed) fs.writeFileSync(sessionFile, JSON.stringify(opts.seed));
  return { module: await import(`../dist/agent/sessions.js?instance=${instance}`), sessionFile };
}

test("stores and returns a session id for a chat", async () => {
  const { module: sessions } = await loadSessions();

  sessions.setSession("chat-a", "sess-a");

  assert.equal(sessions.getSession("chat-a"), "sess-a");
  assert.equal(sessions.getSession("chat-unknown"), undefined);
});

test("persists sessions so they survive a restart", async () => {
  const { module: sessions, sessionFile: file } = await loadSessions();
  sessions.setSession("chat-b", "sess-b");

  const persisted = JSON.parse(fs.readFileSync(file, "utf-8"));

  assert.equal(persisted["chat-b"].sessionId, "sess-b");
  assert.equal(typeof persisted["chat-b"].lastAccessed, "number");
});

test("restores only unexpired sessions from disk on load", async () => {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const { module: sessions } = await loadSessions({
    ttlHours: 12,
    seed: {
      fresh: { sessionId: "sess-fresh", lastAccessed: hourAgo },
      stale: { sessionId: "sess-stale", lastAccessed: hourAgo - 24 * 60 * 60 * 1000 },
    },
  });

  assert.equal(sessions.getSession("fresh"), "sess-fresh");
  assert.equal(sessions.getSession("stale"), undefined);
});

test("an expired session reads as absent rather than resuming a dead conversation", async () => {
  const { module: sessions, sessionFile: file } = await loadSessions({ ttlHours: 0 });
  sessions.setSession("chat-c", "sess-c");

  await new Promise((r) => setTimeout(r, 5));

  assert.equal(sessions.getSession("chat-c"), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), {});
});

test("evictExpired drops expired entries and leaves live ones alone", async () => {
  const { module: sessions } = await loadSessions({
    ttlHours: 12,
    seed: {
      live: { sessionId: "sess-live", lastAccessed: Date.now() },
      old: { sessionId: "sess-old", lastAccessed: Date.now() - 11 * 60 * 60 * 1000 },
    },
  });

  sessions.evictExpired();

  assert.equal(sessions.getSession("live"), "sess-live");
  assert.equal(sessions.getSession("old"), "sess-old");
});

test("clearSession removes the entry and does not throw when no transcript exists", async () => {
  const { module: sessions, sessionFile: file } = await loadSessions();
  sessions.setSession("chat-d", "sess-d-no-transcript-on-disk");

  sessions.clearSession("chat-d");

  assert.equal(sessions.getSession("chat-d"), undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), {});
});

test("clearSession on an unknown chat is a no-op", async () => {
  const { module: sessions } = await loadSessions();

  assert.doesNotThrow(() => sessions.clearSession("never-seen"));
});

test("a corrupt session file does not prevent startup", async () => {
  sessionFile = path.join(TMP_DIR, `sessions-corrupt-${++instance}.json`);
  fs.writeFileSync(sessionFile, "{not json");

  const sessions = await import(`../dist/agent/sessions.js?instance=corrupt-${instance}`);

  assert.equal(sessions.getSession("anything"), undefined);
  sessions.setSession("chat-e", "sess-e");
  assert.equal(sessions.getSession("chat-e"), "sess-e");
});
