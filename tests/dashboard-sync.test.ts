import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  createDashboardSyncer,
  dashboardSyncEffect,
  localIsoDate,
} from "../dist/notion/dashboard-sync.js";

// ─── detection ────────────────────────────────────────────────────────────────

test("a helper log call marks the Dashboard dirty", () => {
  assert.equal(
    dashboardSyncEffect('node scripts/notion.ts log --db "Workout Log" --set "Session=Push A"'),
    "dirty",
  );
});

test("the container form with cd and the .mjs script counts", () => {
  assert.equal(
    dashboardSyncEffect('cd /data && node /app/scripts/notion.mjs log --db "Workout Log"'),
    "dirty",
  );
});

test("multi-line log with backslash continuations counts", () => {
  const cmd = [
    'node scripts/notion.ts log --db "Workout Log" \\',
    '  --set "Session=Push A" --set "Date=2026-06-23" \\',
    '  --set "RPE (1-10)=8"',
  ].join("\n");
  assert.equal(dashboardSyncEffect(cmd), "dirty");
});

test("log --dry-run does not count, even on a continuation line", () => {
  assert.equal(dashboardSyncEffect('node scripts/notion.ts log --db "Goals" --dry-run'), null);
  assert.equal(
    dashboardSyncEffect('node scripts/notion.ts log --db "Workout Log" \\\n  --dry-run'),
    null,
  );
});

test("--help does not count", () => {
  assert.equal(dashboardSyncEffect("node scripts/notion.ts --help"), null);
  assert.equal(dashboardSyncEffect("node scripts/notion.ts log --help"), null);
  // A help call after a write must not clear the dirty state either.
  assert.equal(
    dashboardSyncEffect(
      'node scripts/notion.ts log --db "Goals" && node scripts/notion.ts sync-dashboard --help',
    ),
    "dirty",
  );
});

test("flag-like words inside a quoted value, or -h after the subcommand, still count as writes", () => {
  // The helper only honours a whole --help or --dry-run argument, and -h only
  // as the command itself, so these all write the row.
  for (const cmd of [
    'node scripts/notion.ts log --db "Workout Log" --set "Notes=3x5 -h grip"',
    'node scripts/notion.ts log --db "Workout Log" --set "Notes=skipped the --dry-run idea"',
    "node scripts/notion.ts log --db 'Workout Log' --set 'Notes=read --help later'",
    'node scripts/notion.ts log --db "Workout Log" --set "Notes=felt good" -h',
  ]) {
    assert.equal(dashboardSyncEffect(cmd), "dirty", cmd);
  }
});

test("an unquoted --dry-run after a quoted value still means no write", () => {
  assert.equal(
    dashboardSyncEffect(
      'node scripts/notion.ts log --db "Workout Log" --set "Notes=x y" --dry-run',
    ),
    null,
  );
});

test("read-only and non-row subcommands do not count", () => {
  assert.equal(dashboardSyncEffect('node scripts/notion.ts query-recent --db "Workout Log"'), null);
  assert.equal(dashboardSyncEffect("node scripts/notion.ts append --page abc --md 'x'"), null);
  assert.equal(dashboardSyncEffect("node scripts/notion.ts refresh-tile --tile nextSession"), null);
  assert.equal(dashboardSyncEffect("ls data && cat PERSONAL.md"), null);
});

test("sync-dashboard reports synced", () => {
  assert.equal(
    dashboardSyncEffect("node scripts/notion.ts sync-dashboard --now 2026-06-30"),
    "synced",
  );
});

test("order within one command decides: log then sync is synced, sync then log is dirty", () => {
  assert.equal(
    dashboardSyncEffect(
      'node scripts/notion.ts log --db "Body Stats" --set "Bodyweight=80" && node scripts/notion.ts sync-dashboard --now 2026-06-30',
    ),
    "synced",
  );
  assert.equal(
    dashboardSyncEffect(
      'node scripts/notion.ts sync-dashboard --now 2026-06-30; node scripts/notion.ts log --db "Goals" --set "Goal=Squat 100kg"',
    ),
    "dirty",
  );
});

test("a quoted separator inside a --set value does not hide the write", () => {
  assert.equal(
    dashboardSyncEffect(
      'node scripts/notion.ts log --db "Workout Log" --set "Notes=bench; then OHP" --set "RPE=8"',
    ),
    "dirty",
  );
});

test("a quoted script path with spaces is recognised", () => {
  assert.equal(
    dashboardSyncEffect('node "/home/me/my repo/scripts/notion.ts" log --db "Workout Log"'),
    "dirty",
  );
});

// ─── date ─────────────────────────────────────────────────────────────────────

test("localIsoDate uses the configured timezone, not UTC", () => {
  // 23:30 UTC on the 1st is already the 2nd in Rome and still the 1st in New York.
  const at = new Date("2026-03-01T23:30:00Z");
  assert.equal(localIsoDate("Europe/Rome", at), "2026-03-02");
  assert.equal(localIsoDate("America/New_York", at), "2026-03-01");
  assert.equal(localIsoDate("UTC", at), "2026-03-01");
});

// ─── spawn and coalesce ───────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

function harness(timeoutMs = 60_000) {
  const spawns: { command: string; args: string[]; cwd: string; child: FakeChild }[] = [];
  const lines: string[] = [];
  const syncer = createDashboardSyncer({
    cwd: "/app",
    timeoutMs,
    log: (line) => lines.push(line),
    spawn: (command, args, options) => {
      const child = new FakeChild();
      spawns.push({ command, args, cwd: options.cwd, child });
      return child;
    },
  });
  return { syncer, spawns, lines };
}

test("spawns the helper's sync-dashboard with the date from the project root", () => {
  const { syncer, spawns } = harness();
  syncer.request("2026-06-30");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.match(spawns[0].args[0], /scripts[\\/]notion\.ts$/);
  assert.deepEqual(spawns[0].args.slice(1), ["sync-dashboard", "--now", "2026-06-30"]);
  assert.equal(spawns[0].cwd, "/app");
});

test("logs child output and the exit under the [dashboard] prefix", () => {
  const { syncer, spawns, lines } = harness();
  syncer.request("2026-06-30");
  spawns[0].child.stdout.emit("data", Buffer.from("Synced Dashboard tiles\n"));
  spawns[0].child.stderr.emit("data", "rate limited, retrying\n");
  spawns[0].child.emit("close", 0, null);
  assert.ok(lines.includes("[dashboard] Synced Dashboard tiles"));
  assert.ok(lines.includes("[dashboard] rate limited, retrying"));
  assert.ok(lines.some((l) => l.startsWith("[dashboard] sync done")));
});

test("overlapping requests collapse into one follow-up run with the latest date", () => {
  const { syncer, spawns } = harness();
  syncer.request("2026-06-29");
  syncer.request("2026-06-30");
  syncer.request("2026-07-01");
  assert.equal(spawns.length, 1, "no second process while one is running");

  spawns[0].child.emit("close", 0, null);
  assert.equal(spawns.length, 2, "exactly one queued run starts");
  assert.equal(spawns[1].args.at(-1), "2026-07-01");

  spawns[1].child.emit("close", 0, null);
  assert.equal(spawns.length, 2, "nothing left pending");
});

test("error followed by close settles once, so a queued run starts only once", () => {
  const { syncer, spawns, lines } = harness();
  syncer.request("2026-06-30");
  syncer.request("2026-07-01");
  spawns[0].child.emit("error", new Error("spawn ENOENT"));
  spawns[0].child.emit("close", -2, null);
  assert.equal(spawns.length, 2);
  assert.ok(lines.some((l) => l.includes("sync failed: spawn ENOENT")));
});

test("a non-zero exit is logged and the syncer stays usable", () => {
  const { syncer, spawns, lines } = harness();
  syncer.request("2026-06-30");
  spawns[0].child.emit("close", 1, null);
  assert.ok(lines.some((l) => l.includes("sync exited with 1")));
  syncer.request("2026-06-30");
  assert.equal(spawns.length, 2);
});

test("a hung sync is killed after the timeout and does not wedge the queue", async () => {
  const { syncer, spawns, lines } = harness(20);
  syncer.request("2026-06-30");
  syncer.request("2026-07-01");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(spawns[0].child.killed, true);
  assert.ok(lines.some((l) => l.includes("timed out")));
  assert.equal(spawns.length, 2, "the queued run started after the timeout");
  spawns[1].child.emit("close", 0, null);
});

test("a spawner that throws never escapes request()", () => {
  const lines: string[] = [];
  const syncer = createDashboardSyncer({
    cwd: "/app",
    log: (line) => lines.push(line),
    spawn: () => {
      throw new Error("EAGAIN");
    },
  });
  assert.doesNotThrow(() => syncer.request("2026-06-30"));
  assert.ok(lines.some((l) => l.includes("failed to start: EAGAIN")));
  // Not stuck in the running state.
  assert.doesNotThrow(() => syncer.request("2026-06-30"));
  assert.equal(lines.filter((l) => l.includes("failed to start")).length, 2);
});
