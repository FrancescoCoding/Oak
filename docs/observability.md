# Observability

Every agent run leaves a record. The point is that the agent is operated, not just
built: turn counts, latency, tool mix, error rate and cost are measured from what
actually happened rather than recalled by the model.

## What is recorded

One JSON object per line, appended when a run finishes (success, SDK error, or a
thrown exception, including each retry attempt separately).

| Field | Source | Notes |
|---|---|---|
| `ts` | wall clock | ISO 8601, written at completion |
| `chatId`, `userLabel` | inbound message | redacted before writing |
| `source` | caller | `telegram` or `scheduled` |
| `modelTier`, `model` | runner | `fast` or `standard`, plus the resolved model id |
| `sessionId` | SDK `system/init` | the same id used for session resume |
| `subtype`, `isError` | SDK result message | `success`, an SDK error subtype, or `exception` when `query()` threw |
| `numTurns` | SDK | assistant turns consumed against the `maxTurns` budget |
| `durationMs`, `durationApiMs` | SDK | wall clock and API time; falls back to a locally measured duration if the run threw before a result |
| `totalCostUsd` | SDK | absent or zero under subscription auth |
| `usage`, `modelUsage` | SDK | input/output/cache tokens, and the per-model breakdown when present |
| `toolCounts` | streamed `tool_use` blocks | tool name to invocation count, counted by the runner itself |
| `permissionDenials` | SDK | count only |
| `attempt` | retry loop | 1-based; a retried run writes one record per attempt |
| `outcome` | final reply text | whitespace-collapsed, redacted, first 200 characters |

## Where it lives

`./data/agent-runs.jsonl`, overridable with `RUN_LOG_FILE` (`src/config.ts`, same
pattern as `SESSION_FILE`). `data/` is gitignored, so the log never leaves the host.

JSONL append via `fs.appendFile`, deliberately not the `writeJsonAtomic` helper used
for the session and schedule files. Those are small documents where a torn write
would lose everything; this is an append-only history where a torn write costs one
line, and the reader skips lines that do not parse.

## Design constraints

**Never throw.** Instrumentation that can break the thing it measures is worse than
no instrumentation. `appendRunRecord` wraps serialisation and I/O in a single
try/catch, warns on failure, and resolves. The runner's own logging closure is
wrapped again, so even building the record cannot escape into the coaching path.
The append is fire-and-forget (`void appendRunRecord(...)`): it is never awaited on
the hot path, which is only safe because the promise cannot reject.

**Always redact.** `chatId`, `userLabel` and the outcome sample all pass through
`redactSecrets` before they are written. The log is held to the same standard as an
outbound Telegram message, because a run record can contain anything the model said.

**Pure aggregation.** `aggregateStats(records)` does no I/O and is unit-tested
directly (`tests/runlog.test.mjs`) for percentiles, tool shares, empty input, and
runs with no cost field.

## The /stats command

`/stats` is a hard-coded short-circuit in `src/index.ts`, next to `/new` and
`/reset`. It reads the log, aggregates the last 7 days, and replies. No `query()`
call, no model, no tokens: the numbers cannot drift from the record. The reply goes
out through the same `replyTo` path as every other message, so it is redacted and
chunked identically.

Cost is reported as `subscription` when no run priced itself, which is the normal
case under `CLAUDE_CODE_OAUTH_TOKEN`. When some runs do report a cost, the summary
sums those and says how many runs had none, rather than implying the total is
complete.

## Samples

A line from `data/agent-runs.jsonl` (wrapped here for reading; it is one line):

```json
{"ts":"2026-07-19T18:04:11.912Z","chatId":"123456789","userLabel":"@fg","source":"telegram",
 "modelTier":"standard","model":"claude-sonnet-4-6","sessionId":"a41f9c2e-...","subtype":"success",
 "isError":false,"numTurns":7,"durationMs":24831,"durationApiMs":19204,
 "usage":{"inputTokens":1842,"outputTokens":690,"cacheReadTokens":41203},
 "toolCounts":{"Bash":4,"Read":2,"Skill":1},"permissionDenials":0,"attempt":1,
 "outcome":"Logged it. 5x5 back squat at 82.5kg, up 2.5kg on last week. Next session is Thursday, upper push."}
```

And the reply to `/stats`:

```
Last 7 days
Runs: 34 (1 errored), 168 turns
Latency: p50 18.4s, p95 47.1s
Source: telegram 29, scheduled 5
Top tools: Bash 61%, Read 22%, Skill 9%
Cost: subscription (no per-run cost reported)
```
