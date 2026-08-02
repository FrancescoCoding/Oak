import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, mock, test } from "node:test";

// The runner drives the Agent SDK, so the SDK specifier is mocked before the
// compiled runner is imported. Requires --experimental-test-module-mocks (set on
// the npm test script). Config is read at import time, hence the dummy env and
// the temp session file: nothing here should touch the real data/ directory.
process.env.TELEGRAM_BOT_TOKEN ??= "0:test";
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oak-runner-"));
process.env.SESSION_FILE = path.join(TMP_DIR, "sessions.json");
process.env.RUN_LOG_FILE = path.join(TMP_DIR, "agent-runs.jsonl");

/**
 * Each test installs a script: one entry per expected query() call, describing
 * the messages that call yields and whether it then throws. calls records the
 * options the runner passed, so retry counts and resume are assertable.
 */
let script = [];
const calls = [];

mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: {
    query: (args) => {
      const step = script[calls.length] ?? script[script.length - 1];
      calls.push(args);
      return (async function* () {
        for (const message of step.messages ?? []) yield message;
        if (step.throws) throw step.throws;
      })();
    },
  },
});

const { runAgent } = await import("../dist/agent/runner.js");

const initMessage = (sessionId) => ({ type: "system", subtype: "init", session_id: sessionId });
const resultMessage = (text) => ({ type: "result", subtype: "success", result: text });

beforeEach(() => {
  script = [];
  calls.length = 0;
});

test("returns the text carried by the result message", async () => {
  script = [{ messages: [initMessage("sess-1"), resultMessage("Squats today. Go.")] }];

  const response = await runAgent({ userMessage: "what today?", chatId: "chat-result" });

  assert.equal(response.text, "Squats today. Go.");
  assert.equal(response.sessionId, "sess-1");
  assert.equal(calls.length, 1);
});

test("resumes the stored session on the next message from the same chat", async () => {
  script = [{ messages: [initMessage("sess-resume"), resultMessage("ok")] }];

  await runAgent({ userMessage: "first", chatId: "chat-resume" });
  await runAgent({ userMessage: "second", chatId: "chat-resume" });

  assert.equal(calls[0].options.resume, undefined);
  assert.equal(calls[1].options.resume, "sess-resume");
});

test("retries a transient failure that happens before the session starts", async () => {
  const transient = new Error("connect ETIMEDOUT 160.79.104.10:443");
  script = [
    { throws: transient },
    { throws: transient },
    { messages: [initMessage("sess-late"), resultMessage("recovered")] },
  ];

  const response = await runAgent({ userMessage: "hi", chatId: "chat-transient" });

  assert.equal(response.text, "recovered");
  // MAX_QUERY_ATTEMPTS is 3: two retries after the initial attempt.
  assert.equal(calls.length, 3);
});

test("gives up after the third attempt and rethrows", async () => {
  script = [{ throws: new Error("fetch failed") }];

  await assert.rejects(runAgent({ userMessage: "hi", chatId: "chat-exhausted" }), /fetch failed/);
  assert.equal(calls.length, 3);
});

test("does not retry once a session exists (avoids duplicate Notion writes)", async () => {
  // The init message means the agent started and may already have run tools that
  // wrote to Notion. Retrying the whole query would replay those writes.
  script = [{ messages: [initMessage("sess-started")], throws: new Error("socket hang up") }];

  await assert.rejects(
    runAgent({ userMessage: "log 5x5 squats at 80kg", chatId: "chat-midflight" }),
    /socket hang up/,
  );
  assert.equal(calls.length, 1);
});

test("does not retry a non-transient failure", async () => {
  script = [{ throws: new Error("spawn claude ENOENT") }];

  await assert.rejects(runAgent({ userMessage: "hi", chatId: "chat-fatal" }), /ENOENT/);
  assert.equal(calls.length, 1);
});

test("reports a usage limit to the user instead of throwing", async () => {
  script = [{ throws: new Error("Claude AI usage limit reached") }];

  const response = await runAgent({ userMessage: "hi", chatId: "chat-limit" });

  assert.match(response.text, /usage limit/i);
  assert.equal(response.sessionId, undefined);
  assert.equal(calls.length, 1);
});

test("clears the session when the usage limit is hit, so the next turn starts fresh", async () => {
  script = [{ messages: [initMessage("sess-doomed"), resultMessage("ok")] }];
  await runAgent({ userMessage: "hi", chatId: "chat-limit-clear" });

  script = [{ throws: new Error("quota exceeded") }];
  calls.length = 0;
  await runAgent({ userMessage: "hi again", chatId: "chat-limit-clear" });

  script = [{ messages: [initMessage("sess-new"), resultMessage("ok")] }];
  calls.length = 0;
  await runAgent({ userMessage: "third", chatId: "chat-limit-clear" });

  assert.equal(calls[0].options.resume, undefined);
});
