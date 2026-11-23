import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, mock, test } from "node:test";

// Same setup as runner-retry.test.ts: config is read at import time, so env is
// set first, and nothing may touch the real data/ directory. NOTION_TOKEN is a
// dummy so the host sync path is reachable; the syncer itself is mocked, so no
// process is spawned and no network is hit.
process.env.TELEGRAM_BOT_TOKEN ??= "0:test";
process.env.NOTION_TOKEN = "secret_test";
process.env.HOST_DASHBOARD_SYNC = "true";
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-runner-activity-"));
process.env.SESSION_FILE = path.join(TMP_DIR, "sessions.json");
process.env.RUN_LOG_FILE = path.join(TMP_DIR, "agent-runs.jsonl");

let messages: unknown[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: () =>
      (async function* () {
        for (const message of messages) yield message;
      })(),
  },
});

// Keep the real pure detection, replace only the syncer. The "?real" query
// loads a separate instance that the mock below does not intercept.
const syncModuleUrl = new URL("../dist/notion/dashboard-sync.js", import.meta.url).href;
const real = await import(`${syncModuleUrl}?real`);
const syncRequests: string[] = [];
mock.module(syncModuleUrl, {
  namedExports: {
    dashboardSyncEffect: real.dashboardSyncEffect,
    localIsoDate: real.localIsoDate,
    createDashboardSyncer: () => ({ request: (now: string) => syncRequests.push(now) }),
  },
});

const { runAgent } = await import("../dist/agent/runner.js");

const init = { type: "system", subtype: "init", session_id: "sess-activity" };
const ok = { type: "result", subtype: "success", is_error: false, result: "Logged." };
const toolUse = (name: string, input: Record<string, unknown>, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id: `t-${Math.random()}`, name, input }] },
});
const bash = (command: string) => toolUse("Bash", { command });

const LOG = 'node scripts/notion.ts log --db "Workout Log" --set "Session=Push A"';
const SYNC = "node scripts/notion.ts sync-dashboard --now 2026-06-30";

let chat = 0;
const run = (onActivity?: (e: { tool: string; command?: string }) => void) =>
  runAgent({ userMessage: "did push day", chatId: `chat-activity-${++chat}`, onActivity });

beforeEach(() => {
  messages = [];
  syncRequests.length = 0;
});

test("onActivity fires once per top-level tool_use with the Bash command or Skill name", async () => {
  messages = [
    init,
    toolUse("Skill", { skill: "log-workout" }),
    bash(LOG),
    toolUse("Read", { file_path: "PERSONAL.md" }),
    toolUse("Bash", { command: "echo from a subagent" }, "parent-1"),
    ok,
  ];
  const events: { tool: string; command?: string }[] = [];
  await run((e) => events.push(e));

  assert.deepEqual(events, [
    { tool: "Skill", command: "log-workout" },
    { tool: "Bash", command: LOG },
    { tool: "Read" },
  ]);
});

test("onActivity commands are truncated to 200 characters", async () => {
  messages = [init, bash(`echo ${"x".repeat(500)}`), ok];
  const events: { tool: string; command?: string }[] = [];
  await run((e) => events.push(e));
  assert.equal(events[0].command?.length, 200);
});

test("a throwing or rejecting onActivity never breaks the run", async () => {
  messages = [init, bash("ls"), bash("pwd"), ok];
  const sync = await run(() => {
    throw new Error("telegram down");
  });
  assert.equal(sync.text, "Logged.");

  const async = await run((() => Promise.reject(new Error("telegram down"))) as () => void);
  assert.equal(async.text, "Logged.");
});

test("a helper log write triggers one host sync with today's date", async () => {
  messages = [init, bash(LOG), ok];
  await run();
  assert.equal(syncRequests.length, 1);
  assert.match(syncRequests[0], /^\d{4}-\d{2}-\d{2}$/);
});

test("no host sync when the agent already synced after its write", async () => {
  messages = [init, bash(LOG), bash(SYNC), ok];
  await run();
  assert.equal(syncRequests.length, 0);
});

test("a sync before the write does not count as synced", async () => {
  messages = [init, bash(SYNC), bash(LOG), ok];
  await run();
  assert.equal(syncRequests.length, 1);
});

test("no host sync for read-only runs, dry runs, or subagent tool calls", async () => {
  messages = [
    init,
    bash('node scripts/notion.ts query-recent --db "Workout Log"'),
    bash(`${LOG} --dry-run`),
    toolUse("Bash", { command: LOG }, "parent-1"),
    ok,
  ];
  await run();
  assert.equal(syncRequests.length, 0);
});

test("a write is still synced when the run then ends in an error result", async () => {
  messages = [
    init,
    bash(LOG),
    { type: "result", subtype: "error_max_turns", is_error: true, result: "" },
  ];
  await run();
  assert.equal(syncRequests.length, 1);
});
