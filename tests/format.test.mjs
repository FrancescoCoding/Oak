import assert from "node:assert/strict";
import { test } from "node:test";
import { toPlainText, toTelegramHtml } from "../dist/channel/format.js";

// ─── toTelegramHtml ───────────────────────────────────────────────────────────

test("converts **bold** to <b>", () => {
  assert.equal(toTelegramHtml("lift **heavy** today"), "lift <b>heavy</b> today");
});

test("converts _italic_ to <i>", () => {
  assert.equal(toTelegramHtml("be _consistent_"), "be <i>consistent</i>");
});

test("headings become bold lines", () => {
  assert.equal(toTelegramHtml("# Session"), "<b>Session</b>");
});

test("bullets become bullet dots", () => {
  assert.equal(toTelegramHtml("- squats\n- bench"), "• squats\n• bench");
});

test("links become anchor tags", () => {
  assert.equal(
    toTelegramHtml("[docs](https://example.com)"),
    '<a href="https://example.com">docs</a>',
  );
});

test("escapes HTML-significant characters in prose", () => {
  assert.equal(toTelegramHtml("5 < 8 & rising"), "5 &lt; 8 &amp; rising");
});

test("leaves markdown inside code spans literal", () => {
  assert.equal(toTelegramHtml("use `**not bold**`"), "use <code>**not bold**</code>");
});

test("preserves fenced code blocks", () => {
  assert.equal(toTelegramHtml("```\nx = 1\n```"), "<pre>x = 1</pre>");
});

test("collapses em dashes to commas in prose", () => {
  assert.equal(toTelegramHtml("rest — then push"), "rest, then push");
});

test("keeps en-dash numeric ranges intact", () => {
  assert.equal(toTelegramHtml("do 8–12 reps"), "do 8–12 reps");
});

// ─── toPlainText ──────────────────────────────────────────────────────────────

test("strips bold markers to plain text", () => {
  assert.equal(toPlainText("lift **heavy**"), "lift heavy");
});

test("renders links as text with url in parens", () => {
  assert.equal(toPlainText("[docs](https://example.com)"), "docs (https://example.com)");
});

test("strips em dashes in plain text too", () => {
  assert.equal(toPlainText("rest — then push"), "rest, then push");
});
