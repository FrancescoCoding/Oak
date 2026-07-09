import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { type Attachment, buildUserContent } from "../media/attachments.js";
import { notionConfigured } from "../notion/status.js";
import { personaSystemPrompt, pickPersonality } from "./personalities.js";
import { clearSession, getSession, setSession } from "./sessions.js";

/**
 * Single-message stream. The SDK takes the prompt as an async iterable of user
 * messages, which is what lets us attach images and PDFs (a content blocks array)
 * rather than only plain text.
 */
async function* singleMessage(
  text: string,
  attachments?: Attachment[],
): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: buildUserContent(text, attachments) as SDKUserMessage["message"]["content"],
    },
    parent_tool_use_id: null,
    session_id: "",
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// runner.ts lives at src/agent/, so the repo root is two levels up.
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

export type ModelTier = "fast" | "standard";

// ─── Lightweight query classifier ─────────────────────────────────────────────
//
// Routes short, clearly transactional logging messages (e.g. "did 5x5 squats at
// 80kg") to the cheaper fast model, and keeps everything that smells like coaching,
// planning, or advice on the standard model. Conservative by design: when in doubt,
// return "standard". Only applied to new chats; existing sessions stay on standard
// to avoid switching models mid-conversation.

const STANDARD_PATTERNS = [
  /\b(plan|recommend|suggest|advise|advice|should i|what.?should|why|how do|how should|design|review|analyse|analyze|explain|motivate|feeling|tired|sore|injur|pain|diet|nutrition|macro|calorie|meal|eat|goal|progress|report|compare|trend)\b/,
];

const FAST_PREFIXES = [/^(log|logged|did|done|completed|finished|just did|add)\b/];

export function classifyQuery(text: string): ModelTier {
  const lower = text.toLowerCase().trim();

  for (const pattern of STANDARD_PATTERNS) {
    if (pattern.test(lower)) return "standard";
  }

  if (FAST_PREFIXES.some((p) => p.test(lower)) && lower.length < 200) {
    return "fast";
  }

  return "standard";
}

export interface AgentResponse {
  text: string;
  sessionId?: string;
}

// Whole-query retry for transient startup failures.
const MAX_QUERY_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Claude subscription cap (reset on a rolling window), not a transient limit. */
function isUsageLimit(msg: string): boolean {
  const l = msg.toLowerCase();
  return (
    l.includes("usage limit") ||
    l.includes("usage_limit") ||
    l.includes("credit balance is too low") ||
    l.includes("insufficient credit") ||
    l.includes("quota exceeded")
  );
}

/** Transient network/overload errors worth a quick retry. */
function isTransient(msg: string): boolean {
  const l = msg.toLowerCase();
  return /etimedout|econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed|overloaded|\b50[234]\b|service unavailable|timed out|timeout/.test(
    l,
  );
}

/**
 * A short, code-computed context line prepended to every prompt so the facts the
 * onboarding routine depends on are present deterministically on every turn
 * (including resumed sessions, where the model would otherwise skip onboarding).
 * Reports Notion/workspace status and whether PERSONAL.md is filled in.
 */
function buildSessionContext(): string {
  const parts: string[] = [];
  if (notionConfigured()) {
    parts.push("Notion configured");
    const idsPath = path.join(PROJECT_ROOT, "data", "notion-ids.json");
    if (fs.existsSync(idsPath)) {
      parts.push("workspace built");
    } else {
      // A missing id cache does not prove the workspace is missing: on a fresh
      // deployment the gitignored data/ dir starts empty while the workspace
      // already exists in Notion. If a Hub is pinned, say so and tell the model
      // to verify against Notion instead of asserting emptiness.
      const hubPinned =
        Boolean(config.notionParentPageId) ||
        fs.existsSync(path.join(PROJECT_ROOT, "config", "notion-hub.json"));
      parts.push(
        hubPinned
          ? "id cache missing but a Hub page is pinned; the workspace likely already exists. Run `node scripts/notion.mjs resolve-workspace` (deterministic, read-only) to repopulate the cache before any Notion read, and never conclude the log is empty from a resolution failure"
          : "workspace not built yet (run setup-notion)",
      );
    }
  } else {
    parts.push("Notion not configured (no persistence)");
  }

  const personalPath = path.join(PROJECT_ROOT, "PERSONAL.md");
  if (!fs.existsSync(personalPath)) {
    parts.push("PERSONAL.md missing (ask for goals and how they eat, then create it)");
  } else {
    let looksTemplate = false;
    try {
      // The example's first goal; if it survives, the file was not personalised.
      looksTemplate = fs
        .readFileSync(personalPath, "utf-8")
        .includes("e.g. Add 10kg to my squat by September");
    } catch {
      /* unreadable: treat as set, the agent can still ask */
    }
    parts.push(
      looksTemplate
        ? "PERSONAL.md still has placeholder goals (ask the user to fill them)"
        : "PERSONAL.md set",
    );
  }
  return parts.join("; ");
}

/**
 * Run the Claude agent for one incoming message.
 *
 *  - "standard" uses the full coaching model with tools, the coach plugin, and the
 *    Notion REST helpers (scripts/notion.mjs) run via Bash.
 *  - "fast" uses the cheaper model with the same tooling for trivial logging.
 *
 * Auth runs against the Claude subscription via CLAUDE_CODE_OAUTH_TOKEN (set in
 * the environment, not passed here) combined with the claude_code system prompt
 * preset. Do not set ANTHROPIC_API_KEY or queries will bill the metered API.
 */
export async function runAgent(opts: {
  userMessage: string;
  chatId: string;
  userLabel?: string;
  modelTier?: ModelTier;
  attachments?: Attachment[];
  onProgress?: (text: string) => void;
}): Promise<AgentResponse> {
  const { userMessage, chatId, userLabel, attachments, onProgress } = opts;
  const modelTier = opts.modelTier ?? "standard";
  const existingSession = getSession(chatId);

  const model = modelTier === "standard" ? config.model : config.modelFast;

  const now = new Date().toLocaleString("en-GB", { timeZone: config.timezone });
  const context = buildSessionContext();
  const prompt = `[Telegram chat ${chatId}${userLabel ? ` | ${userLabel}` : ""} | local time: ${now} (${config.timezone})]\n[context: ${context}]\n${userMessage}`;

  const persona = pickPersonality(chatId);
  const personaAppend = personaSystemPrompt(persona);

  console.log(
    `[agent] Starting query (${model}, ${modelTier}, persona=${persona.id}):`,
    userMessage.slice(0, 100),
  );

  for (let attempt = 0; ; attempt++) {
    let resultText = "";
    let sessionId: string | undefined;
    try {
      for await (const message of query({
        prompt: singleMessage(prompt, attachments),
        options: {
          cwd: PROJECT_ROOT,
          model,
          effort: config.reasoningEffort,
          title: `tg-${chatId}`,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            excludeDynamicSections: true,
            ...(personaAppend ? { append: personaAppend } : {}),
          },
          resume: existingSession,
          // Load the project CLAUDE.md (the coach persona) and surface every skill
          // discovered from the loaded plugin. skills: "all" is the SDK's single
          // place to turn skills on; without it, plugin SKILL.md discovery is left
          // to ambiguous defaults and the coach may never see its skills.
          settingSources: ["project"],
          skills: "all",
          allowedTools: [
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Glob",
            "Grep",
            "WebFetch",
            "WebSearch",
            "Skill",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          maxTurns: modelTier === "fast" ? 15 : 60,
          plugins: [{ type: "local", path: path.join(PROJECT_ROOT, "coach-plugin") }],
          forwardSubagentText: onProgress != null,
        },
      })) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = (message as any).session_id;
          if (sessionId) setSession(chatId, sessionId);
        }

        if (
          onProgress &&
          message.type === "assistant" &&
          (message as any).parent_tool_use_id != null
        ) {
          const blocks = (message as any).message?.content ?? [];
          const text = blocks
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text as string)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (text) onProgress(text);
        }

        if ("result" in message) {
          resultText = (message as any).result ?? "";
        }
      }

      return { text: resultText, sessionId };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error("[agent] query() threw:", msg);

      // Subscription usage limit hit. Return a clear message rather than throwing.
      // No restart needed: the next query() spawns a fresh subprocess, so once the
      // limit window resets the very next request will work.
      if (isUsageLimit(msg)) {
        clearSession(chatId);
        return {
          text: "I have hit the Claude subscription usage limit. Limits reset on a rolling window, so try again shortly. No restart needed.",
          sessionId: undefined,
        };
      }

      // Transient failure before the agent started (no session id yet, so no tool
      // side effects have run): safe to retry with backoff. Once a session is
      // established we do not blind-retry, to avoid duplicate Notion writes.
      if (isTransient(msg) && sessionId === undefined && attempt < MAX_QUERY_ATTEMPTS - 1) {
        const waitMs = Math.min(2 ** attempt, 8) * 1000;
        console.warn(
          `[agent] transient error; retry ${attempt + 1}/${MAX_QUERY_ATTEMPTS - 1} in ${waitMs}ms`,
        );
        await sleep(waitMs);
        continue;
      }

      throw err;
    }
  }
}
