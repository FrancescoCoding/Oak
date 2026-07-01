import assert from "node:assert/strict";
import { test } from "node:test";
import { TtlSet } from "../dist/util/dedupe.js";

test("first sighting of an id is not a replay", () => {
  const set = new TtlSet(1000);
  assert.equal(set.seen("update-1"), false);
});

test("a second sighting within the TTL is a replay", () => {
  const set = new TtlSet(1000);
  set.seen("update-1");
  assert.equal(set.seen("update-1"), true);
});

test("distinct ids are tracked independently", () => {
  const set = new TtlSet(1000);
  assert.equal(set.seen("a"), false);
  assert.equal(set.seen("b"), false);
  assert.equal(set.seen("a"), true);
});

test("an id is forgotten after its TTL elapses", async () => {
  const set = new TtlSet(10);
  set.seen("update-1");
  await new Promise((r) => setTimeout(r, 25));
  // Swept out on the next access, so it reads as a fresh sighting.
  assert.equal(set.seen("update-1"), false);
});
