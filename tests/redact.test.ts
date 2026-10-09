import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../dist/util/redact.js";

// redactSecrets is the last line of defence for outbound messages: if the model
// ever echoes a credential, it must not reach the chat. These tests pin the
// pattern coverage so a regression here is caught loudly.

test("passes ordinary prose through untouched", () => {
  const text = "Nice work today. 5x5 squats at 80kg, that is progress.";
  assert.equal(redactSecrets(text, {}), text);
});

test("redacts an Anthropic API key", () => {
  const out = redactSecrets("key sk-ant-abc123DEF456ghi789 leaked", {});
  assert.ok(!out.includes("sk-ant-abc123DEF456ghi789"));
  assert.match(out, /\[redacted-api-key\]/);
});

test("redacts a GitHub token", () => {
  const out = redactSecrets("ghp_0123456789abcdefghijABCDEFGHIJ0123", {});
  assert.match(out, /\[redacted-github-token\]/);
});

test("redacts a Notion integration token", () => {
  const out = redactSecrets("ntn_0123456789abcdefghij0123456789ab", {});
  assert.match(out, /\[redacted-notion-token\]/);
});

test("redacts a Telegram bot token", () => {
  const out = redactSecrets("123456789:AAEabcdefghijklmnopqrstuvwxyz0123456", {});
  assert.match(out, /\[redacted-telegram-token\]/);
});

test("redacts a JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456";
  const out = redactSecrets(`token ${jwt}`, {});
  assert.match(out, /\[redacted-jwt\]/);
  assert.ok(!out.includes(jwt));
});

test("redacts credentials embedded in a connection URL", () => {
  const out = redactSecrets("postgres://admin:s3cretPass@db.example.com/app", {});
  assert.ok(!out.includes("s3cretPass"));
  assert.match(out, /\[redacted\]/);
});

test("redacts a Bearer token in echoed headers", () => {
  const out = redactSecrets("Authorization: Bearer abcdef0123456789ABCDEF0123", {});
  assert.match(out, /Bearer \[redacted\]/);
});

test("redacts a PEM private key block", () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\nlines\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`here ${pem}`, {});
  assert.match(out, /\[redacted-private-key\]/);
  assert.ok(!out.includes("MIIBOgIBAAJBAK"));
});
