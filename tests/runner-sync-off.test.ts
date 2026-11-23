import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";

// Its own file because config is read at import time: this one runs with the
// host Dashboard sync switched off, and checks the agent is told to sync itself.
process.env.TELEGRAM_BOT_TOKEN ??= "0:test";
process.env.NOTION_TOKEN = "secret_test";
process.env.HOST_DASHBOARD_SYNC = "off";
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-runner-sync-off-"));
process.env.SESSION_FILE = path.join(TMP_DIR, "sessions.json");
process.env.RUN_LOG_FILE = path.join(TMP_DIR, "agent-runs.jsonl");

const prompts: string[] = [];
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) =>
      (async function* () {
        for await (const m of prompt) prompts.push(JSON.stringify(m.message.content));
        yield { type: "system", subtype: "init", session_id: "sess-sync-off" };
        yield {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: "tool_use",
                id: "t-1",
                name: "Bash",
                input: { command: 'node scripts/notion.ts log --db "Workout Log"' },
              },
            ],
          },
        };
        yield { type: "result", subtype: "success", is_error: false, result: "Logged." };
      })(),
  },
});

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

test("with HOST_DASHBOARD_SYNC off the agent is told to sync and the host does not", async () => {
  const res = await runAgent({ userMessage: "did push day", chatId: "chat-sync-off" });
  assert.equal(res.text, "Logged.");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /host Dashboard sync is off/);
  assert.equal(syncRequests.length, 0);
});
