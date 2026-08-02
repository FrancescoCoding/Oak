/**
 * Agent run log: one JSONL line per query() run.
 *
 * Every run the agent performs (Telegram message or scheduled task) writes a
 * single record with the SDK's own metrics (turns, duration, cost, token usage,
 * permission denials) plus the tool names it invoked: /stats reads this file back.
 *
 * Two constraints shape the whole module:
 *
 *  1. Instrumentation must never break the run. Every entry point is wrapped in
 *     try/catch, failures warn and return. appendRunRecord is fire-and-forget:
 *     the caller does not await it, and the promise never rejects.
 *  2. Every free-text field is passed through redactSecrets before it is written,
 *     so the log is as safe to read as an outbound reply.
 *
 * JSONL append rather than writeJsonAtomic: an interrupted append costs one bad
 * line, which the reader skips, instead of truncating the whole history.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { redactSecrets } from "../util/redact.js";

/** How much of the final reply is kept as a sample of the run's outcome. */
const OUTCOME_CHARS = 200;

export type RunSource = "telegram" | "scheduled";

export interface ModelUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

export interface RunRecord {
  ts: string;
  chatId?: string;
  userLabel?: string;
  source: RunSource;
  modelTier?: string;
  model?: string;
  sessionId?: string;
  subtype?: string;
  isError: boolean;
  numTurns?: number;
  durationMs?: number;
  durationApiMs?: number;
  totalCostUsd?: number;
  usage?: ModelUsageSummary;
  modelUsage?: Record<string, ModelUsageSummary>;
  toolCounts?: Record<string, number>;
  permissionDenials?: number;
  attempt: number;
  outcome?: string;
}

function runLogFile(): string {
  return config.runLogFile;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Pull the token/cost fields we care about out of an SDK usage-shaped object. */
export function summariseUsage(usage: unknown): ModelUsageSummary | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const summary: ModelUsageSummary = {
    inputTokens: num(u.input_tokens ?? u.inputTokens),
    outputTokens: num(u.output_tokens ?? u.outputTokens),
    cacheReadTokens: num(u.cache_read_input_tokens ?? u.cacheReadInputTokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens),
    costUsd: num(u.costUSD ?? u.cost_usd ?? u.costUsd),
  };
  const kept = Object.entries(summary).filter(([, v]) => v !== undefined);
  return kept.length > 0 ? (Object.fromEntries(kept) as ModelUsageSummary) : undefined;
}

/** Per-model token and cost breakdown, when the SDK reports one. */
export function summariseModelUsage(
  modelUsage: unknown,
): Record<string, ModelUsageSummary> | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const out: Record<string, ModelUsageSummary> = {};
  for (const [model, usage] of Object.entries(modelUsage as Record<string, unknown>)) {
    const summary = summariseUsage(usage);
    if (summary) out[model] = summary;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Redact and clamp the free-text sample of what the run produced. */
function outcomeSample(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const safe = redactSecrets(text.replace(/\s+/g, " ").trim());
  return safe.slice(0, OUTCOME_CHARS);
}

/**
 * Append one record. Never throws and never rejects: callers on the hot path
 * deliberately do not await it, so a rejection here would surface as an
 * unhandled rejection and take the process down.
 */
export async function appendRunRecord(record: RunRecord): Promise<void> {
  try {
    const safe: RunRecord = {
      ...record,
      chatId: record.chatId ? redactSecrets(record.chatId) : undefined,
      userLabel: record.userLabel ? redactSecrets(record.userLabel) : undefined,
      outcome: outcomeSample(record.outcome),
    };
    const file = runLogFile();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(safe)}\n`, "utf-8");
  } catch (err) {
    console.warn("[runlog] Could not append run record:", (err as Error).message);
  }
}

/**
 * Read records written at or after `sinceMs`. Malformed lines (a torn append, a
 * hand-edited file) are skipped rather than failing the read.
 */
export function readRunRecords(sinceMs?: number): RunRecord[] {
  try {
    const file = runLogFile();
    if (!fs.existsSync(file)) return [];
    const out: RunRecord[] = [];
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let record: RunRecord;
      try {
        record = JSON.parse(line) as RunRecord;
      } catch {
        continue;
      }
      if (sinceMs != null) {
        const ts = Date.parse(record.ts ?? "");
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
      }
      out.push(record);
    }
    return out;
  } catch (err) {
    console.warn("[runlog] Could not read run log:", (err as Error).message);
    return [];
  }
}

export interface RunStats {
  runs: number;
  errors: number;
  totalTurns: number;
  totalCostUsd: number;
  /** Runs with no cost reported: subscription auth does not price a run. */
  runsWithoutCost: number;
  p50DurationMs: number;
  p95DurationMs: number;
  /** Tool names by invocation share, most used first. */
  topTools: Array<{ name: string; count: number; share: number }>;
  bySource: Record<string, number>;
}

/** Nearest-rank percentile over a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** Pure aggregation over run records, so it can be tested without any I/O. */
export function aggregateStats(records: RunRecord[]): RunStats {
  const durations: number[] = [];
  const tools = new Map<string, number>();
  const bySource: Record<string, number> = {};
  let errors = 0;
  let totalTurns = 0;
  let totalCostUsd = 0;
  let runsWithoutCost = 0;
  let toolTotal = 0;

  for (const record of records) {
    if (record.isError) errors++;
    totalTurns += num(record.numTurns) ?? 0;

    const cost = num(record.totalCostUsd) ?? 0;
    if (cost > 0) totalCostUsd += cost;
    else runsWithoutCost++;

    const duration = num(record.durationMs);
    if (duration != null) durations.push(duration);

    const source = record.source ?? "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    for (const [name, count] of Object.entries(record.toolCounts ?? {})) {
      const n = num(count) ?? 0;
      if (n <= 0) continue;
      tools.set(name, (tools.get(name) ?? 0) + n);
      toolTotal += n;
    }
  }

  durations.sort((a, b) => a - b);

  const topTools = [...tools.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({
      name,
      count,
      share: toolTotal > 0 ? count / toolTotal : 0,
    }));

  return {
    runs: records.length,
    errors,
    totalTurns,
    totalCostUsd,
    runsWithoutCost,
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    topTools,
    bySource,
  };
}
