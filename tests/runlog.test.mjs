import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// config reads the environment at import time, so the dummy values (and the
// run log location) have to be in place before the dynamic import below.
process.env.TELEGRAM_BOT_TOKEN ??= "0:test";
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= "sk-ant-oat01-test";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "runlog-test-"));
// Parent is a file, not a directory, so mkdir/appendFile cannot succeed. This is
// the "unwritable target" case: appendRunRecord must still resolve.
const BLOCKED_PARENT = path.join(TMP_DIR, "blocked");
fs.writeFileSync(BLOCKED_PARENT, "not a directory");
process.env.RUN_LOG_FILE = path.join(BLOCKED_PARENT, "agent-runs.jsonl");

const { aggregateStats, appendRunRecord } = await import("../dist/agent/runlog.js");

function run(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    source: "telegram",
    isError: false,
    attempt: 1,
    ...overrides,
  };
}

// ─── aggregateStats ──────────────────────────────────────────────────

test("empty input aggregates to zeroes rather than throwing", () => {
  const stats = aggregateStats([]);
  assert.equal(stats.runs, 0);
  assert.equal(stats.errors, 0);
  assert.equal(stats.totalCostUsd, 0);
  assert.equal(stats.p50DurationMs, 0);
  assert.equal(stats.p95DurationMs, 0);
  assert.deepEqual(stats.topTools, []);
  assert.deepEqual(stats.bySource, {});
});

test("counts runs, errors, turns and sources", () => {
  const stats = aggregateStats([
    run({ numTurns: 3 }),
    run({ numTurns: 5, isError: true }),
    run({ numTurns: 2, source: "scheduled" }),
  ]);
  assert.equal(stats.runs, 3);
  assert.equal(stats.errors, 1);
  assert.equal(stats.totalTurns, 10);
  assert.deepEqual(stats.bySource, { telegram: 2, scheduled: 1 });
});

test("p50 and p95 use nearest rank over the recorded durations", () => {
  const records = [];
  for (let i = 1; i <= 100; i++) records.push(run({ durationMs: i * 100 }));
  const stats = aggregateStats(records);
  assert.equal(stats.p50DurationMs, 5000);
  assert.equal(stats.p95DurationMs, 9500);
});

test("a single run reports itself for both percentiles", () => {
  const stats = aggregateStats([run({ durationMs: 4200 })]);
  assert.equal(stats.p50DurationMs, 4200);
  assert.equal(stats.p95DurationMs, 4200);
});

test("tool shares are counts over total invocations, most used first", () => {
  const stats = aggregateStats([
    run({ toolCounts: { Bash: 6, Read: 2 } }),
    run({ toolCounts: { Bash: 2, Skill: 0 } }),
  ]);
  assert.deepEqual(
    stats.topTools.map((t) => t.name),
    ["Bash", "Read"],
  );
  assert.equal(stats.topTools[0].count, 8);
  assert.equal(stats.topTools[0].share, 0.8);
  assert.equal(stats.topTools[1].share, 0.2);
});

test("missing cost fields are reported as absent, not as zero spend", () => {
  const stats = aggregateStats([run(), run({ totalCostUsd: null }), run({ totalCostUsd: 0.25 })]);
  assert.equal(stats.runsWithoutCost, 2);
  assert.ok(Math.abs(stats.totalCostUsd - 0.25) < 1e-9);
});

// ─── appendRunRecord ─────────────────────────────────────────────────
//
// Instrumentation must never break the run it is measuring. Both of these
// assert on "resolves and warns", never on a thrown error.

test("resolves when the log target cannot be written", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await appendRunRecord(run({ outcome: "logged squats" }));
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[runlog\]/);
});

test("resolves when the record contains circular or odd values", async () => {
  const record = run({ numTurns: Number.NaN, durationMs: Number.POSITIVE_INFINITY });
  record.self = record;
  const original = console.warn;
  console.warn = () => {};
  try {
    await appendRunRecord(record);
  } finally {
    console.warn = original;
  }
});
