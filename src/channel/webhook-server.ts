import crypto from "node:crypto";
import http from "node:http";
import type { Bot } from "grammy";
import { config } from "../config.js";
import { type ScheduledTask, executeTask, getTask } from "../scheduler/scheduler.js";
import { TtlSet } from "../util/dedupe.js";

/**
 * HTTP server for webhook mode. This is what lets the service scale to zero on a
 * host like Cloud Run: there is no long-polling loop, the platform cold-starts an
 * instance when a request arrives. Routes:
 *
 *  - POST /webhook/telegram : Telegram pushes updates here. The secret token set
 *    via setWebhook is echoed back on every delivery and verified. We acknowledge
 *    with 200 immediately and process in the background, so a long agent run never
 *    makes Telegram time out and retry. Duplicate deliveries are dropped.
 *  - POST /cron/run : the external scheduler (Cloud Scheduler) calls this to fire a
 *    reminder. Authorised with a bearer CRON_SECRET. Body: {"taskId": "..."} to run
 *    a defined reminder, or {"chatId": "...", "prompt": "..."} for an ad hoc one.
 *  - GET /healthz : liveness.
 *
 * For background work to complete after the 200 response, the Cloud Run service
 * must run with CPU always allocated (--no-cpu-throttling); otherwise the instance
 * freezes the moment the response is sent. min-instances can still be 0.
 */

// Telegram has no per-webhook signing secret; instead a secret_token set via
// setWebhook is echoed back on every delivery. Derived from the bot token so
// there is no extra secret to manage.
const webhookSecret = crypto.createHash("sha256").update(config.telegramBotToken).digest("hex");

// Telegram redelivers until the webhook returns 200; replays are dropped.
const seenUpdates = new TtlSet(10 * 60 * 1000);

// Cap the body so a malformed or hostile POST cannot buffer unbounded memory.
// Telegram updates and cron payloads are tiny; 1 MB is comfortably generous.
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      body += c;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function startWebhookServer(bot: Bot): http.Server {
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body?: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz")) {
      send(200, { status: "healthy" });
      return;
    }

    // ── Telegram updates ──────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/webhook/telegram") {
      const token = req.headers["x-telegram-bot-api-secret-token"];
      if (typeof token !== "string" || !timingSafeEqual(token, webhookSecret)) {
        send(401, { error: "bad secret token" });
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        send(413, { error: "payload too large" });
        return;
      }
      // Acknowledge immediately; Telegram retries on a slow response.
      send(200);

      let update: any;
      try {
        update = JSON.parse(raw);
      } catch {
        return;
      }
      if (update.update_id !== undefined && seenUpdates.seen(String(update.update_id))) {
        return;
      }
      // Fire and forget: runs are long, the response is already sent. Requires
      // CPU-always-allocated on Cloud Run so this keeps executing.
      void bot
        .handleUpdate(update)
        .catch((err) => console.error("[webhook] handleUpdate failed:", err?.message));
      return;
    }

    // ── Reminder trigger from the external scheduler ──────────────────
    if (req.method === "POST" && req.url === "/cron/run") {
      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${config.cronSecret}`;
      if (!config.cronSecret || !timingSafeEqual(auth, expected)) {
        send(401, { error: "unauthorized" });
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        send(413, { error: "payload too large" });
        return;
      }
      send(200, { ok: true });

      let payload: { taskId?: string; chatId?: string; prompt?: string };
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        return;
      }

      let task: ScheduledTask | undefined;
      if (payload.taskId) {
        task = getTask(payload.taskId);
        if (!task) {
          console.warn(`[cron] No task with id ${payload.taskId}`);
          return;
        }
      } else if (payload.chatId && payload.prompt) {
        task = {
          id: `adhoc-${Date.now()}`,
          name: "ad hoc reminder",
          cron: "",
          prompt: payload.prompt,
          chatId: payload.chatId,
          enabled: true,
          modelTier: "standard",
        };
      } else {
        console.warn("[cron] /cron/run needs taskId, or chatId and prompt");
        return;
      }
      void executeTask(task).catch((err) => console.error("[cron] task failed:", err?.message));
      return;
    }

    send(404, { error: "not found" });
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`[webhook] Listening on :${config.port} (/webhook/telegram, /cron/run, /healthz)`);
  });
  return server;
}

/** Register the Telegram webhook with Telegram on startup. */
export async function registerTelegramWebhook(bot: Bot): Promise<void> {
  if (!config.publicBaseUrl) {
    console.warn("[webhook] PUBLIC_BASE_URL unset; cannot register Telegram webhook");
    return;
  }
  const url = new URL("/webhook/telegram", config.publicBaseUrl).toString();
  await bot.api.setWebhook(url, {
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
  });
  console.log(`[webhook] Telegram webhook set to ${url}`);
}
