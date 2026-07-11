import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEventBody,
  formatEventLine,
  parseArgs,
  parseReminders,
  resolveWindow,
  toEventTime,
} from "./calendar.mjs";

// ─── arg parsing ───────────────────────────────────────────────────────────────

test("parseArgs: flags with values and boolean flags", () => {
  const args = parseArgs(["--title", "Push A", "--create", "--start", "2026-07-13T18:00"]);
  assert.equal(args.title, "Push A");
  assert.equal(args.create, true);
  assert.equal(args.start, "2026-07-13T18:00");
});

// ─── event times ───────────────────────────────────────────────────────────────

test("toEventTime: bare date becomes an all-day event time", () => {
  assert.deepEqual(toEventTime("2026-07-13"), { date: "2026-07-13" });
});

test("toEventTime: local datetime gets seconds and the configured timezone", () => {
  const t = toEventTime("2026-07-13T18:00", "Europe/London");
  assert.deepEqual(t, { dateTime: "2026-07-13T18:00:00", timeZone: "Europe/London" });
});

test("toEventTime: explicit offset is kept and no timezone is attached", () => {
  assert.deepEqual(toEventTime("2026-07-13T18:00:00Z"), { dateTime: "2026-07-13T18:00:00Z" });
  assert.deepEqual(toEventTime("2026-07-13T18:00+02:00", "Europe/London"), {
    dateTime: "2026-07-13T18:00:00+02:00",
  });
});

test("toEventTime: garbage is rejected with a helpful message", () => {
  assert.throws(() => toEventTime("next tuesday"), /Invalid time/);
  assert.throws(() => toEventTime(""), /Invalid time/);
});

// ─── reminders ─────────────────────────────────────────────────────────────────

test("parseReminders: single popup override", () => {
  assert.deepEqual(parseReminders("popup:30"), {
    useDefault: false,
    overrides: [{ method: "popup", minutes: 30 }],
  });
});

test("parseReminders: multiple overrides", () => {
  assert.deepEqual(parseReminders("popup:30,email:60").overrides, [
    { method: "popup", minutes: 30 },
    { method: "email", minutes: 60 },
  ]);
});

test("parseReminders: default and none sentinels", () => {
  assert.deepEqual(parseReminders("default"), { useDefault: true });
  assert.deepEqual(parseReminders("none"), { useDefault: false, overrides: [] });
});

test("parseReminders: bad method or minutes is rejected", () => {
  assert.throws(() => parseReminders("sms:30"), /Invalid reminder/);
  assert.throws(() => parseReminders("popup:soon"), /Invalid reminder/);
});

// ─── event body ────────────────────────────────────────────────────────────────

test("buildEventBody: create requires title, start, and end", () => {
  assert.throws(
    () => buildEventBody({ start: "2026-07-13T18:00", end: "2026-07-13T19:00" }),
    /--title/,
  );
  assert.throws(() => buildEventBody({ title: "Push A" }), /--start and --end/);
});

test("buildEventBody: create defaults to a 30-minute popup reminder", () => {
  const body = buildEventBody({
    title: "Push A",
    start: "2026-07-13T18:00",
    end: "2026-07-13T19:00",
  });
  assert.equal(body.summary, "Push A");
  assert.deepEqual(body.reminders, {
    useDefault: false,
    overrides: [{ method: "popup", minutes: 30 }],
  });
});

test("buildEventBody: mixed all-day and timed bounds are rejected", () => {
  assert.throws(
    () => buildEventBody({ title: "x", start: "2026-07-13", end: "2026-07-13T19:00" }),
    /both/,
  );
});

test("buildEventBody: recurrence must be an RRULE and is wrapped in an array", () => {
  const body = buildEventBody({
    title: "Push A",
    start: "2026-07-13T18:00",
    end: "2026-07-13T19:00",
    recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO,TH",
  });
  assert.deepEqual(body.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=MO,TH"]);
  assert.throws(
    () =>
      buildEventBody({
        title: "x",
        start: "2026-07-13T18:00",
        end: "2026-07-13T19:00",
        recurrence: "weekly",
      }),
    /RRULE/,
  );
});

test("buildEventBody: partial update includes only the provided fields", () => {
  const body = buildEventBody({ start: "2026-07-14T18:00" }, { partial: true });
  assert.deepEqual(Object.keys(body), ["start"]);
});

// ─── list windows ──────────────────────────────────────────────────────────────

test("resolveWindow: --to defaults to 7 days after --from", () => {
  const { timeMin, timeMax } = resolveWindow("2026-07-13", undefined);
  assert.equal(timeMin, "2026-07-13T00:00:00");
  assert.equal(timeMax, "2026-07-20T00:00:00");
});

test("resolveWindow: a bare --to date spans through the end of that day", () => {
  const { timeMax } = resolveWindow("2026-07-13", "2026-07-15");
  assert.equal(timeMax, "2026-07-15T23:59:59");
});

test("resolveWindow: --from is required", () => {
  assert.throws(() => resolveWindow(undefined, undefined), /--from is required/);
});

// ─── formatting ────────────────────────────────────────────────────────────────

test("formatEventLine: timed event shows a compact time range and the id", () => {
  const line = formatEventLine({
    id: "abc123",
    summary: "Push A",
    start: { dateTime: "2026-07-13T18:00:00+01:00" },
    end: { dateTime: "2026-07-13T19:00:00+01:00" },
  });
  assert.match(line, /2026-07-13 18:00 -> 19:00/);
  assert.match(line, /Push A/);
  assert.match(line, /\[id: abc123\]/);
});

test("formatEventLine: all-day and recurring markers", () => {
  const line = formatEventLine({
    id: "x",
    summary: "Deload week",
    start: { date: "2026-07-13" },
    end: { date: "2026-07-14" },
    recurrence: ["RRULE:FREQ=WEEKLY"],
  });
  assert.match(line, /all day/);
  assert.match(line, /\[recurring\]/);
});
