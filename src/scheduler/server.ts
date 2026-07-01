import http from "node:http";
import { type ScheduledTask, addTask, listTasks, removeTask } from "./scheduler.js";

/**
 * Localhost-only control plane for reminders. The agent (running as a child process
 * on the same host) can curl these endpoints to manage scheduled tasks live, so
 * "remind me to train at 6pm on weekdays" takes effect immediately rather than on
 * the next restart. Bound to 127.0.0.1 only, so it is not reachable off-box.
 */

const PORT = 9130;

export function startSchedulerServer(): void {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && req.url === "/tasks") {
      send(200, { tasks: listTasks() });
      return;
    }

    if (req.method === "POST" && req.url === "/tasks") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const t = JSON.parse(body) as Partial<ScheduledTask>;
          if (!t.name || !t.cron || !t.prompt || !t.chatId) {
            send(400, { error: "name, cron, prompt and chatId are required" });
            return;
          }
          const task: ScheduledTask = {
            id: t.id || `task-${Date.now()}`,
            name: t.name,
            cron: t.cron,
            prompt: t.prompt,
            chatId: t.chatId,
            enabled: t.enabled ?? true,
            modelTier: t.modelTier ?? "standard",
          };
          addTask(task);
          send(200, { ok: true, task });
        } catch (err: any) {
          send(500, { error: err.message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && req.url?.startsWith("/tasks/")) {
      const id = decodeURIComponent(req.url.slice("/tasks/".length));
      const removed = removeTask(id);
      send(removed ? 200 : 404, { ok: removed });
      return;
    }

    send(404, { error: "Not found" });
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[scheduler] Control plane on http://localhost:${PORT}/tasks`);
  });
}
