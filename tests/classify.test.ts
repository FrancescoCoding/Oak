import assert from "node:assert/strict";
import { test } from "node:test";

// runner.js transitively loads config, which requires TELEGRAM_BOT_TOKEN at
// import time, so provide a dummy before importing and pull classifyQuery in
// dynamically (after the env is set).
process.env.TELEGRAM_BOT_TOKEN ??= "0:test";
const { classifyQuery } = await import("../dist/agent/runner.js");

test("short transactional log lines route to the fast tier", () => {
  assert.equal(classifyQuery("did 5x5 squats at 80kg"), "fast");
  assert.equal(classifyQuery("logged bench 3x8 60kg"), "fast");
});

test("coaching and advice questions stay on the standard tier", () => {
  assert.equal(classifyQuery("what should I train today?"), "standard");
  assert.equal(classifyQuery("plan my week"), "standard");
  assert.equal(classifyQuery("my knee is in pain"), "standard");
});

test("a log-shaped message that mentions a coaching topic stays standard", () => {
  // "did" prefix, but "progress" pulls it back to standard (conservative default).
  assert.equal(classifyQuery("did my progress improve this month?"), "standard");
});

test("anything unrecognised defaults to standard", () => {
  assert.equal(classifyQuery("hey coach"), "standard");
});
