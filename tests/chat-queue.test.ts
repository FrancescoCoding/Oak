import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatQueue, joinMessages } from "../dist/channel/chat-queue.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A promise plus its resolver, for holding a task open until the test says so. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    open = r;
  });
  return { promise, open };
}

test("tasks for one chat run one at a time, in arrival order", async () => {
  const q = new ChatQueue();
  const log: string[] = [];
  let running = 0;
  const task = (name: string, ms: number) => async () => {
    running++;
    assert.equal(running, 1, "two tasks for the same chat overlapped");
    log.push(`start ${name}`);
    await tick(ms);
    log.push(`end ${name}`);
    running--;
  };
  await Promise.all([
    q.run("a", task("1", 15)),
    q.run("a", task("2", 1)),
    q.run("a", task("3", 5)),
  ]);
  assert.deepEqual(log, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
});

test("a rejected task reaches its caller and does not wedge the queue", async () => {
  const q = new ChatQueue();
  const failed = q.run("a", async () => {
    throw new Error("boom");
  });
  const next = q.run("a", async () => "still going");
  await assert.rejects(failed, /boom/);
  assert.equal(await next, "still going");
});

test("a failing message handler does not wedge the queue either", async () => {
  const q = new ChatQueue();
  const first = q.enqueue("a", "one", async () => {
    throw new Error("handler failed");
  });
  await assert.rejects(first, /handler failed/);
  const seen: string[][] = [];
  await q.enqueue("a", "two", async (_k, batch: string[]) => {
    seen.push(batch);
  });
  assert.deepEqual(seen, [["two"]]);
});

test("different chats do not wait on each other", async () => {
  const q = new ChatQueue();
  const held = gate();
  const slow = q.run("a", () => held.promise);
  let otherRan = false;
  await q.run("b", async () => {
    otherRan = true;
  });
  assert.equal(otherRan, true);
  held.open();
  await slow;
});

test("idle chats leave nothing behind", async () => {
  const q = new ChatQueue();
  await Promise.all([
    q.run("a", async () => {}),
    q
      .run("b", async () => {
        throw new Error("x");
      })
      .catch(() => {}),
    q.enqueue("c", "m", async () => {}),
    q.enqueue("d", null, async () => {}),
  ]);
  await tick();
  assert.equal(q.activeChats, 0);
});

test("messages waiting behind a run are handed over together, in order", async () => {
  const q = new ChatQueue();
  const batches: string[][] = [];
  const held = gate();
  const handler = async (_k: string, batch: string[]) => {
    batches.push(batch);
    if (batches.length === 1) await held.promise;
  };
  const first = q.enqueue("a", "one", handler);
  await tick();
  const rest = [q.enqueue("a", "two", handler), q.enqueue("a", "three", handler)];
  held.open();
  await Promise.all([first, ...rest]);
  assert.deepEqual(batches, [["one"], ["two", "three"]]);
});

test("arrival order wins even when an earlier message prepares slowly", async () => {
  const q = new ChatQueue();
  const batches: string[][] = [];
  const voice = gate<string>();
  const done = [
    q.enqueue("a", voice.promise, async (_k, b: string[]) => {
      batches.push(b);
    }),
    q.enqueue("a", "typed after", async (_k, b: string[]) => {
      batches.push(b);
    }),
  ];
  await tick();
  voice.open("voice transcript");
  await Promise.all(done);
  assert.deepEqual(batches, [["voice transcript", "typed after"]]);
});

test("messages that prepare to nothing are dropped without a run", async () => {
  const q = new ChatQueue();
  let calls = 0;
  await Promise.all([
    q.enqueue("a", null, async () => {
      calls++;
    }),
    q.enqueue("a", Promise.reject(new Error("download failed")), async () => {
      calls++;
    }),
  ]);
  assert.equal(calls, 0);
});

test("a preparation that fails while waiting behind a long run is dropped quietly", async () => {
  const q = new ChatQueue();
  const held = gate();
  const seen: string[][] = [];
  const first = q.enqueue("a", "one", () => held.promise);
  await tick();
  const record = async (_k: string, b: string[]) => {
    seen.push(b);
  };
  const failing = q.enqueue("a", Promise.reject(new Error("reply failed")), record);
  const after = q.enqueue("a", "two", record);
  // Give an unhandled rejection the chance to surface before the run finishes.
  await tick(20);
  held.open();
  await Promise.all([first, failing, after]);
  assert.deepEqual(seen, [["two"]]);
});

test("a run() task is never merged and keeps its place in line", async () => {
  const q = new ChatQueue();
  const log: string[] = [];
  const held = gate();
  const handler = async (_k: string, batch: string[]) => {
    log.push(batch.join("+"));
    if (batch[0] === "one") await held.promise;
  };
  const all = [
    q.enqueue("a", "one", handler),
    q.enqueue("a", "two", handler),
    q.run("a", async () => {
      log.push("reset");
    }),
    q.enqueue("a", "three", handler),
  ];
  await tick();
  held.open();
  await Promise.all(all);
  // "two" joined "one" (both waiting before the run started); "three" came after the reset.
  assert.deepEqual(log, ["one+two", "reset", "three"]);
});

test("joinMessages keeps text and attachments in order", () => {
  const joined = joinMessages([
    { text: "did squats 5x5 at 80", attachments: [] },
    { text: "  ", attachments: ["photo-1"] },
    { text: "and bench 3x8", attachments: ["photo-2", "pdf-1"] },
  ]);
  assert.equal(
    joined.text,
    "did squats 5x5 at 80\n\n(attachment 1, no caption)\n\nand bench 3x8 (attachments 2, 3)",
  );
  assert.deepEqual(joined.attachments, ["photo-1", "photo-2", "pdf-1"]);
});

test("joinMessages ties each caption to its own photo", () => {
  const joined = joinMessages([
    { text: "", attachments: ["meal-a"] },
    { text: "lunch", attachments: ["meal-b"] },
  ]);
  assert.equal(joined.text, "(attachment 1, no caption)\n\nlunch (attachment 2)");
  assert.deepEqual(joined.attachments, ["meal-a", "meal-b"]);
});

test("joinMessages leaves an album and plain text batches untagged", () => {
  // Telegram sends an album as one message per photo, captioned on the first only.
  const album = joinMessages([
    { text: "breakfast", attachments: ["p1"], group: "g1" },
    { text: "", attachments: ["p2"], group: "g1" },
    { text: "", attachments: ["p3"], group: "g1" },
  ]);
  assert.equal(album.text, "breakfast");
  assert.deepEqual(album.attachments, ["p1", "p2", "p3"]);

  const texts = joinMessages([
    { text: "squats 5x5", attachments: [] },
    { text: "felt heavy", attachments: [] },
  ]);
  assert.equal(texts.text, "squats 5x5\n\nfelt heavy");

  const single = joinMessages([{ text: "lunch", attachments: ["p1"] }]);
  assert.equal(single.text, "lunch");
});

test("joinMessages numbers attachments across an album and a later photo", () => {
  const joined = joinMessages([
    { text: "breakfast", attachments: ["p1"], group: "g1" },
    { text: "", attachments: ["p2"], group: "g1" },
    { text: "dinner", attachments: ["p3"] },
  ]);
  assert.equal(joined.text, "breakfast (attachments 1, 2)\n\ndinner (attachment 3)");
});
