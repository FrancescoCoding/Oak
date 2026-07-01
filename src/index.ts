import http from "node:http";
import { Bot } from "grammy";
import { pickPersonality } from "./agent/personalities.js";
import { classifyQuery, runAgent } from "./agent/runner.js";
import { clearSession, evictExpired, getSession } from "./agent/sessions.js";
import { toPlainText, toTelegramHtml } from "./channel/format.js";
import { registerBot, sendMessage, splitMessage } from "./channel/notify.js";
import { isAllowed } from "./channel/permissions.js";
import { registerTelegramWebhook, startWebhookServer } from "./channel/webhook-server.js";
import { checkClaudeAuth, config } from "./config.js";
import { type Attachment, isSupportedAttachment } from "./media/attachments.js";
import { transcribeAudio, transcriptionAvailable, warmupTranscriber } from "./media/transcribe.js";
import { notionConfigured } from "./notion/status.js";
import { initScheduler } from "./scheduler/scheduler.js";
import { startSchedulerServer } from "./scheduler/server.js";
import { redactSecrets } from "./util/redact.js";

const bot = new Bot(config.telegramBotToken);

// Respect Telegram flood control: on a 429, wait the requested retry_after and
// retry, so replies are not dropped when messages go out too fast.
bot.api.config.use(async (prev, method, payload, signal) => {
  let result = await prev(method, payload, signal);
  for (
    let attempt = 0;
    attempt < 3 && !result.ok && (result as any).error_code === 429;
    attempt++
  ) {
    const retryAfter = (result as any).parameters?.retry_after ?? 1;
    await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
    result = await prev(method, payload, signal);
  }
  return result;
});

registerBot(bot);

// ─── Concurrency limiter ─────────────────────────────────────────────
//
// The SDK spawns a subprocess per query, so unbounded concurrency could fork a lot
// of processes. Cap it and queue the rest. For a single user this rarely engages,
// but it keeps a burst of messages from overwhelming the host.

const MAX_CONCURRENT_QUERIES = 2;
let activeQueries = 0;
const queryQueue: Array<() => void> = [];

function drainQueue(): void {
  while (queryQueue.length > 0 && activeQueries < MAX_CONCURRENT_QUERIES) {
    const next = queryQueue.shift()!;
    activeQueries++;
    next();
  }
}

async function acquireSlot(): Promise<void> {
  if (activeQueries < MAX_CONCURRENT_QUERIES) {
    activeQueries++;
    return;
  }
  return new Promise<void>((resolve) => queryQueue.push(resolve));
}

function releaseSlot(): void {
  activeQueries--;
  drainQueue();
}

// ─── Command shortcuts ───────────────────────────────────────────────
//
// Slash commands map to natural-language prompts so the agent handles them with the
// same skills as a free-text message.

const COMMAND_PROMPTS: Record<string, string> = {
  start:
    "Introduce yourself briefly as my fitness coach and tell me how to use you: I can log workouts in plain language, ask what to train, ask for a weekly plan, ask for nutrition advice, and ask for a progress report. Keep it short and welcoming.",
  help: "List what you can help me with: logging workouts (including photos of meals, food labels, or progress pictures), recommending today's session, planning my week, nutrition advice, progress reports, and reminders. Mention that /new starts a fresh conversation. Keep it concise.",
  setup:
    "Set up my Notion workspace for training: create the Workout Log and Goals databases if they do not already exist, then confirm what you created and how to use them.",
  log: "I want to log a workout. Ask me what I did if I have not already told you.",
  plan: "Build my training plan for the coming week and save it to Notion.",
  today: "What should I train today? Base it on my goals, my plan, and recent logs.",
  progress: "Give me a progress report from my logged workouts.",
};

// ─── Message handling ────────────────────────────────────────────────

async function handle(opts: {
  chatId: string;
  userId: number;
  userLabel: string;
  text: string;
  attachments: Attachment[];
  replyTo: (text: string) => Promise<void>;
  typing: () => Promise<void>;
}) {
  const { chatId, userLabel, text, attachments, replyTo, typing } = opts;

  await acquireSlot();
  await typing().catch(() => {});

  // Keep a typing indicator alive while the agent works (it lasts ~5s per call).
  const typingTimer = setInterval(() => typing().catch(() => {}), 4500);

  // Route trivial logging messages to the fast model on new chats only, and only
  // when the fast tier is enabled (off by default for consistent behaviour).
  // Existing sessions stay on the standard model to avoid switching mid-conversation,
  // and a message carrying an attachment is never trivial, so it stays on standard.
  const existingSession = getSession(chatId);
  const modelTier =
    config.fastTierEnabled && !existingSession && attachments.length === 0
      ? classifyQuery(text)
      : "standard";

  try {
    const response = await runAgent({
      userMessage: text,
      chatId,
      userLabel,
      modelTier,
      attachments,
      onProgress: undefined,
    });
    clearInterval(typingTimer);
    await replyTo(response.text || "(no response)");
  } catch (err: any) {
    clearInterval(typingTimer);
    console.error("[index] Agent error:", err?.message, err?.stack);
    await replyTo(classifyError(err?.message ?? "unknown error"));
  } finally {
    releaseSlot();
  }
}

function classifyError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("usage limit") || lower.includes("credit balance is too low"))
    return "I have hit the Claude subscription usage limit. It resets on a rolling window, so try again shortly.";
  if (lower.includes("timeout") || lower.includes("timed out"))
    return "That took too long and timed out. Worth trying again.";
  if (lower.includes("max_turns") || lower.includes("max turns"))
    return "That request got too involved for one go. Try breaking it into smaller asks.";
  if (lower.includes("notion"))
    return "I am having trouble reaching Notion right now. Check the integration token and that the page is shared with it, then try again.";
  return "Something went wrong handling that. I have logged the details. Try again in a moment.";
}

// ─── Grammy wiring ───────────────────────────────────────────────────

// Claude caps a single image at ~5MB and PDFs share the request budget, so skip
// anything larger rather than failing the whole run on an oversized upload.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Download one Telegram file as a base64 attachment, or null on any failure. */
async function downloadAttachment(
  fileId: string,
  mediaType: string,
  declaredSize: number | undefined,
): Promise<Attachment | null> {
  try {
    if (declaredSize && declaredSize > MAX_ATTACHMENT_BYTES) return null;
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) return null;
    return { mediaType, data: buf.toString("base64") };
  } catch (err) {
    console.warn("[index] Attachment download failed:", (err as Error).message);
    return null;
  }
}

/** Pull any usable image or PDF off an inbound message so the coach can see it. */
async function collectAttachments(msg: any): Promise<Attachment[]> {
  const out: Attachment[] = [];
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const att = await downloadAttachment(largest.file_id, "image/jpeg", largest.file_size);
    if (att) out.push(att);
  }
  if (msg.document) {
    const mime = msg.document.mime_type ?? "";
    if (isSupportedAttachment(mime)) {
      const att = await downloadAttachment(msg.document.file_id, mime, msg.document.file_size);
      if (att) out.push(att);
    }
  }
  return out;
}

/**
 * If the message is a voice note / audio, download and transcribe it locally.
 * Returns the transcript, "" if nothing intelligible, or null if not audio.
 */
async function transcribeVoiceNote(msg: any): Promise<string | null> {
  const media = msg.voice ?? msg.audio ?? msg.video_note;
  if (!media) return null;
  const att = await downloadAttachment(media.file_id, "audio/ogg", media.file_size);
  if (!att) return "";
  const bytes = Buffer.from(att.data, "base64");
  return await transcribeAudio(bytes);
}

bot.on("message", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAllowed(userId)) {
    // Silently ignore strangers so a public bot is not chatty to everyone.
    return;
  }

  const chatId = String(ctx.chat.id);
  const userLabel = ctx.from?.username ? `@${ctx.from.username}` : `user ${userId}`;
  let text = ctx.message.text ?? ctx.message.caption ?? "";

  // Map a leading slash command to its prompt or built-in action.
  if (text.startsWith("/")) {
    const cmd = text.slice(1).split(/\s+/)[0].split("@")[0].toLowerCase();
    const rest = text.slice(1 + cmd.length).trim();

    // /new clears the conversation so the next message starts fresh.
    if (cmd === "new" || cmd === "reset") {
      clearSession(chatId);
      await ctx.reply("Started a fresh session. Previous context is cleared.");
      return;
    }

    const mapped = COMMAND_PROMPTS[cmd];
    if (mapped) text = rest ? `${mapped}\n\n${rest}` : mapped;
  }

  const attachments = await collectAttachments(ctx.message);

  // Voice notes have no audio path to the model, so transcribe and treat the
  // transcript as the user's text. A caption (text) takes precedence if both.
  if (!text.trim()) {
    const isVoice = Boolean(ctx.message?.voice || ctx.message?.audio || ctx.message?.video_note);
    if (isVoice && !transcriptionAvailable()) {
      await ctx.reply(
        "I can't transcribe voice notes in this setup. Type it out and I've got you.",
      );
      return;
    }
    try {
      const transcript = await transcribeVoiceNote(ctx.message);
      if (transcript === "") {
        if (isVoice) {
          await ctx.reply("I couldn't make out that voice note. Try again, or type it out.");
        }
      } else if (transcript != null) {
        text = transcript;
      }
    } catch (err) {
      console.error("[index] transcription failed:", (err as Error).message);
      await ctx.reply("I had trouble transcribing that voice note. Type it out and I've got you.");
      return;
    }
  }

  if (!text.trim() && attachments.length === 0) return;

  // Send a reply as Telegram HTML, falling back to plain text if Telegram rejects
  // the entities. All outbound text is scrubbed for secrets first.
  const replyTo = async (out: string) => {
    const safe = redactSecrets(out);
    for (const chunk of splitMessage(safe, 4096)) {
      try {
        await ctx.reply(toTelegramHtml(chunk), { parse_mode: "HTML" });
      } catch {
        await ctx.reply(toPlainText(chunk));
      }
    }
  };

  await handle({
    chatId,
    userId,
    userLabel,
    text,
    attachments,
    typing: () => ctx.replyWithChatAction("typing").then(() => undefined),
    replyTo,
  });
});

bot.catch((err) => {
  console.error("[index] Bot error:", err.message);
});

// ─── Health check ────────────────────────────────────────────────────

let botRunning = false;

// In webhook mode the webhook server owns the HTTP port and serves /healthz.
// In polling mode there is no HTTP server otherwise, so run a tiny health server.
const healthServer =
  config.mode === "polling"
    ? http.createServer((req, res) => {
        if (req.url === "/healthz" || req.url === "/readyz") {
          res.writeHead(botRunning ? 200 : 503);
          res.end(JSON.stringify({ status: botRunning ? "healthy" : "starting" }));
        } else {
          res.writeHead(404);
          res.end();
        }
      })
    : null;
// In webhook mode this holds the HTTP server so shutdown can close it cleanly.
let webhookServer: http.Server | null = null;
healthServer?.listen(config.port, "0.0.0.0", () =>
  console.log(`[health] Listening on :${config.port}/healthz`),
);

// ─── Periodic session cleanup ────────────────────────────────────────

setInterval(evictExpired, 15 * 60 * 1000);

// ─── Start ───────────────────────────────────────────────────────────

(async () => {
  checkClaudeAuth();
  startSchedulerServer();
  await initScheduler();
  await bot.init();

  if (config.mode === "webhook") {
    // Scale-to-zero path: Telegram pushes updates to the HTTP server, and an
    // external scheduler fires reminders. No long-polling loop runs.
    webhookServer = startWebhookServer(bot);
    await registerTelegramWebhook(bot);
    botRunning = true;
    console.log(
      `${config.agentName} is running (webhook mode). Notion ${notionConfigured() ? "enabled" : "disabled"}.`,
    );
    // No online ping here: in scale-to-zero the instance may start cold for any
    // request, so a startup message would fire on every cold start.
    return;
  }

  // Polling path: long-poll Telegram. Best for local and always-on hosts.
  botRunning = true;
  warmupTranscriber();
  console.log(
    `${config.agentName} is running (polling mode). Notion ${notionConfigured() ? "enabled" : "disabled"}.`,
  );
  if (config.ownerChatId) {
    const ownerPersona = pickPersonality(config.ownerChatId);
    const onlineName = ownerPersona.voice ? ownerPersona.name : config.agentName;
    sendMessage(config.ownerChatId, `${onlineName} is online and ready.`).catch(() => {});
  }
  // Remove any webhook left over from a previous webhook-mode deploy, or Telegram
  // will keep delivering there and getUpdates will conflict.
  await bot.api.deleteWebhook().catch(() => {});
  // start() blocks while long-polling, so it is the last thing we await.
  await bot.start();
})();

// ─── Graceful shutdown ───────────────────────────────────────────────

async function shutdown() {
  console.log("[shutdown] Shutting down...");
  healthServer?.close();
  webhookServer?.close();
  // bot.stop() only applies to the long-polling loop; ignore if it was never started.
  if (config.mode === "polling") await bot.stop().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
