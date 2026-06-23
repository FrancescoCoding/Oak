import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { getSession, setSession, clearSession } from "./sessions.js";
import { getMcpServers } from "../notion/mcp.js";
import { type Attachment, buildUserContent } from "../media/attachments.js";
import { pickPersonality, personaSystemPrompt } from "./personalities.js";

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

const FAST_PREFIXES = [
  /^(log|logged|did|done|completed|finished|just did|add)\b/,
];

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

/**
 * Run the Claude agent for one incoming message.
 *
 *  - "standard" uses the full coaching model with tools, plugin, and Notion MCP.
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
  const prompt = `[Telegram chat ${chatId}${userLabel ? ` | ${userLabel}` : ""} | local time: ${now} (${config.timezone})]\n${userMessage}`;

  const persona = pickPersonality(chatId);
  const personaAppend = personaSystemPrompt(persona);

  let resultText = "";
  let sessionId: string | undefined;

  console.log(`[agent] Starting query (${model}, ${modelTier}, persona=${persona.id}):`, userMessage.slice(0, 100));

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
          "Bash", "Read", "Write", "Edit", "Glob", "Grep",
          "WebFetch", "WebSearch", "Skill",
        ],
        mcpServers: getMcpServers(),
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
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error("[agent] query() threw:", msg);

    // Subscription usage limit hit. Return a clear message rather than throwing.
    // No restart needed: the next query() spawns a fresh subprocess, so once the
    // limit window resets the very next request will work.
    if (
      msg.toLowerCase().includes("usage limit") ||
      msg.toLowerCase().includes("credit balance is too low")
    ) {
      clearSession(chatId);
      return {
        text: "I have hit the Claude subscription usage limit. Limits reset on a rolling window, so try again shortly. No restart needed.",
        sessionId: undefined,
      };
    }

    throw err;
  }

  return { text: resultText, sessionId };
}
