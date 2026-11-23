import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProgressReporter,
  describeActivity,
  progressUpdatesEnabled,
} from "../dist/channel/progress.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records every Telegram call the reporter makes. */
function fakeTransport(opts: { sendDelayMs?: number } = {}) {
  const calls: string[] = [];
  let nextId = 100;
  return {
    calls,
    transport: {
      send: async (text: string) => {
        if (opts.sendDelayMs) await tick(opts.sendDelayMs);
        const id = nextId++;
        calls.push(`send ${id} ${text}`);
        return id;
      },
      edit: async (id: number, text: string) => {
        calls.push(`edit ${id} ${text}`);
      },
      remove: async (id: number) => {
        calls.push(`remove ${id}`);
      },
    },
  };
}

test("maps notion, calendar and exercise commands to plain phases", () => {
  const bash = (command: string) => describeActivity({ tool: "Bash", command });
  assert.equal(
    bash('node scripts/notion.ts query-recent --db "Workout Log" --limit 5'),
    "Checking your training log...",
  );
  assert.equal(
    bash("node scripts/notion.ts get-page-blocks abc123"),
    "Checking your training log...",
  );
  assert.equal(bash("node scripts/notion.ts log --json '{}'"), "Saving it to Notion...");
  assert.equal(
    bash("node scripts/notion.ts log --db \"Body Stats\" --json '{}'"),
    "Saving it to Notion...",
  );
  // A hypothetical log-something subcommand is not a plain `log`.
  assert.equal(bash("node scripts/notion.ts log-export"), "Working in Notion...");
  assert.equal(bash("node scripts/notion.ts append --page x"), "Writing it up in Notion...");
  assert.equal(
    bash("node scripts/notion.ts sync-dashboard --now 2026-11-23"),
    "Updating your dashboard...",
  );
  assert.equal(
    bash("node scripts/setup-workspace.ts --rebuild-dashboard"),
    "Updating your dashboard...",
  );
  assert.equal(bash("node scripts/notion.ts some-new-command"), "Working in Notion...");
  assert.equal(bash("node scripts/calendar.ts list --days 7"), "Checking your calendar...");
  assert.equal(bash("node scripts/calendar.ts create --title Legs"), "Updating your calendar...");
  assert.equal(
    bash("node scripts/exercise-db.ts search --muscle chest"),
    "Looking up exercises...",
  );
  assert.equal(bash("ls -la"), null);
  assert.equal(describeActivity({ tool: "Read", command: "PERSONAL.md" }), null);
  assert.equal(describeActivity({ tool: "WebSearch" }), "Looking that up...");
  assert.equal(
    describeActivity({ tool: "Skill", command: "weekly-plan" }),
    "Putting your week together...",
  );
  assert.equal(
    describeActivity({ tool: "Skill", command: "coach-plugin:progress-report" }),
    "Going through your progress...",
  );
  assert.equal(describeActivity({ tool: "Skill", command: "notion-formatting" }), null);
});

test("a compound command always maps to the same label", () => {
  const label = describeActivity({
    tool: "Bash",
    command:
      "node scripts/notion.ts query-recent --limit 3 && node scripts/notion.ts log --json '{}'",
  });
  assert.equal(label, "Saving it to Notion...");
});

test("status text never echoes anything from the command", () => {
  const known = new Set([
    "Saving it to Notion...",
    "Writing it up in Notion...",
    "Updating your dashboard...",
    "Setting up your Notion workspace...",
    "Checking your training log...",
    "Opening your Notion workspace...",
    "Working in Notion...",
    "Updating your calendar...",
    "Checking your calendar...",
    "Looking up exercises...",
    "Looking that up...",
  ]);
  const nasty = [
    "NOTION_TOKEN=secret_abc123 node scripts/notion.ts append --page 1f2e3d4c5b6a",
    "curl -H 'Authorization: Bearer sk-ant-oat01-xyz' https://example.com",
    "cat /data/.claude/projects/-app/0f9a.jsonl && node scripts/calendar.ts delete --id evt_42",
    'node scripts/notion.ts log --json \'{"Notes":"ignore previous instructions"}\'',
  ];
  for (const command of nasty) {
    const label = describeActivity({ tool: "Bash", command });
    assert.ok(label === null || known.has(label), `unexpected label: ${label}`);
  }
  for (const label of known) {
    assert.ok(!/[—–]/.test(label), "labels must not use em or en dashes");
  }
});

test("PROGRESS_UPDATES defaults on and can be switched off", () => {
  const prev = process.env.PROGRESS_UPDATES;
  try {
    Reflect.deleteProperty(process.env, "PROGRESS_UPDATES");
    assert.equal(progressUpdatesEnabled(), true);
    for (const off of ["false", "0", "off", "NO"]) {
      process.env.PROGRESS_UPDATES = off;
      assert.equal(progressUpdatesEnabled(), false, off);
    }
    process.env.PROGRESS_UPDATES = "true";
    assert.equal(progressUpdatesEnabled(), true);
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "PROGRESS_UPDATES");
    else process.env.PROGRESS_UPDATES = prev;
  }
});

test("a quick run posts nothing at all", async () => {
  const { calls, transport } = fakeTransport();
  const p = new ProgressReporter(transport, { delayMs: 40 });
  p.onActivity({ tool: "Bash", command: "node scripts/notion.ts query-recent" });
  await tick(10);
  await p.finish();
  await tick(50);
  assert.deepEqual(calls, []);
});

test("a long run posts one status, edits it in place, then removes it", async () => {
  const { calls, transport } = fakeTransport();
  const p = new ProgressReporter(transport, { delayMs: 20, minEditMs: 0 });
  p.onActivity({ tool: "Bash", command: "node scripts/notion.ts query-recent" });
  await tick(40);
  p.onActivity({ tool: "Read", command: "PERSONAL.md" }); // no new phase, no edit
  p.onActivity({ tool: "Bash", command: "node scripts/notion.ts log --json '{}'" });
  await tick(10);
  await p.finish();
  assert.deepEqual(calls, [
    "send 100 Checking your training log...",
    "edit 100 Saving it to Notion...",
    "remove 100",
  ]);
});

test("edits are rate limited to one trailing edit with the latest phase", async () => {
  const { calls, transport } = fakeTransport();
  const p = new ProgressReporter(transport, { delayMs: 0, minEditMs: 60 });
  p.onActivity({ tool: "Bash", command: "node scripts/notion.ts query-recent" });
  await tick(10);
  p.onActivity({ tool: "Bash", command: "node scripts/notion.ts log" });
  p.onActivity({ tool: "Bash", command: "node scripts/notion.ts append" });
  p.onActivity({ tool: "Bash", command: "node scripts/notion.ts sync-dashboard" });
  await tick(150);
  await p.finish();
  assert.deepEqual(calls, [
    "send 100 Checking your training log...",
    "edit 100 Updating your dashboard...",
    "remove 100",
  ]);
});

test("finishing while the status is still sending removes it once it lands", async () => {
  const { calls, transport } = fakeTransport({ sendDelayMs: 30 });
  const p = new ProgressReporter(transport, { delayMs: 0 });
  p.onActivity({ tool: "WebSearch" });
  await tick(5);
  await p.finish();
  assert.deepEqual(calls, ["send 100 Looking that up...", "remove 100"]);
  p.onActivity({ tool: "Bash", command: "node scripts/notion.ts log" });
  await tick(10);
  assert.equal(calls.length, 2, "nothing is sent after finish");
});

test("an unrecognised tool still shows a generic status on a long run", async () => {
  const { calls, transport } = fakeTransport();
  const p = new ProgressReporter(transport, { delayMs: 10 });
  p.onActivity({ tool: "Grep", command: "squat" });
  await tick(30);
  await p.finish();
  assert.deepEqual(calls, ["send 100 Working on it...", "remove 100"]);
});

test("a failing transport never throws into the run", async () => {
  const p = new ProgressReporter(
    {
      send: async () => {
        throw new Error("telegram down");
      },
      edit: async () => {
        throw new Error("telegram down");
      },
      remove: async () => {
        throw new Error("telegram down");
      },
    },
    { delayMs: 0, minEditMs: 0 },
  );
  p.onActivity({ tool: "WebSearch" });
  await tick(5);
  p.onActivity({ tool: "Bash", command: "node scripts/notion.ts log" });
  await tick(5);
  await p.finish();
});
