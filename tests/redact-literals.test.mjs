import assert from "node:assert/strict";
import { test } from "node:test";
import { redactSecrets } from "../dist/util/redact.js";

// The literal-value strategy caches the set of secret-named env values on the
// first call, so these live in their own file (node's test runner isolates each
// file in a separate process) to control which env populates the cache.

test("redacts the literal value of a secret-named env var", () => {
  const env = { MY_API_TOKEN: "supersecretvalue12345" };
  const out = redactSecrets("the token is supersecretvalue12345 ok", env);
  assert.ok(!out.includes("supersecretvalue12345"));
  assert.match(out, /\[redacted\]/);
});

test("does not redact short or non-secret env values", () => {
  // Cache is already populated from the first call; a benign string with no
  // secret substring must pass through unchanged.
  const text = "running in debug at /home/node";
  assert.equal(redactSecrets(text, {}), text);
});
