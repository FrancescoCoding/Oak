import fs from "fs";
import { Cron } from "croner";
import { config } from "../config.js";
import { runAgent, type ModelTier } from "../agent/runner.js";
import { sendMessage } from "../channel/notify.js";
import { writeJsonAtomic } from "../util/atomicfile.js";

/**
 * Cron-based scheduler for proactive coaching: morning session nudges, the weekly
 * plan, reminders. Tasks are persisted to a plain local JSON file.
 *
 * When a task fires, it runs the agent with the task's prompt and pushes the result
 * to the task's chat. Because the agent shares the chat's session, the reminder lands
 * in context with the ongoing conversation.
 */

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  chatId: string;
  enabled: boolean;
  modelTier?: ModelTier;
}

const tasks = new Map<string, { task: ScheduledTask; job: Cron }>();
const SCHEDULE_FILE = config.scheduleFile;

/**
 * Default reminders seeded the first time the agent runs with no schedule file.
 * The user can edit, disable, or remove these by asking the agent in chat. Times
 * are interpreted in the configured timezone.
 */
function defaultTasks(): ScheduledTask[] {
  if (!config.ownerChatId) return [];
  return [
    {
      id: "morning-nudge",
      name: "Morning session nudge",
      cron: "0 8 * * *",
      prompt:
        "Good morning. Tell me what today's training session should be based on my goals, my weekly plan, and what I have logged recently. Keep it short and motivating.",
      chatId: config.ownerChatId,
      enabled: true,
      modelTier: "standard",
    },
    {
      id: "weekly-plan",
      name: "Sunday weekly plan",
      cron: "0 18 * * 0",
      prompt:
        "It is the start of a new week. Build my training plan for the coming week from my goals and recent training volume, then save it to Notion and summarise it for me here.",
      chatId: config.ownerChatId,
      enabled: true,
      modelTier: "standard",
    },
  ];
}

// The task definitions, kept in memory whether or not croner is driving them.
// In webhook mode the external scheduler (Cloud Scheduler) fires them via
// /cron/run, so the in-process croner jobs are not started.
let definitions: ScheduledTask[] = [];

export async function initScheduler(): Promise<void> {
  let loaded = loadFromDisk();

  if (loaded.length === 0) {
    loaded = defaultTasks();
    if (loaded.length > 0) {
      saveToDisk(loaded);
      console.log(`[scheduler] Seeded ${loaded.length} default tasks`);
    }
  }
  definitions = loaded;

  // Only run the in-process cron loop when long-polling. In webhook mode the
  // process is asleep most of the time, so an external scheduler drives reminders.
  if (config.mode === "polling") {
    for (const task of loaded) {
      if (task.enabled) startTask(task);
    }
    console.log(`[scheduler] Loaded ${loaded.length} tasks (${tasks.size} active, croner)`);
  } else {
    console.log(`[scheduler] Loaded ${loaded.length} tasks (webhook mode, external trigger)`);
  }
}

/** Look up a task definition by id (used by the /cron/run endpoint). */
export function getTask(id: string): ScheduledTask | undefined {
  return definitions.find((t) => t.id === id);
}

/** Run a task now: invoke the agent with its prompt and push the result. */
export async function executeTask(task: ScheduledTask): Promise<void> {
  console.log(`[scheduler] Running: ${task.name}`);
  try {
    const response = await runAgent({
      userMessage: task.prompt,
      chatId: task.chatId,
      userLabel: "scheduled task",
      modelTier: task.modelTier ?? "standard",
    });
    await sendMessage(task.chatId, response.text || "(no output)");
  } catch (err: any) {
    console.error(`[scheduler] Task ${task.name} failed:`, err.message);
    await sendMessage(task.chatId, `Scheduled task "${task.name}" failed: ${err.message}`).catch(() => {});
  }
}

export function addTask(task: ScheduledTask): void {
  if (definitions.some((t) => t.id === task.id)) {
    console.warn(`[scheduler] Task id "${task.id}" already exists; replacing it.`);
  }
  definitions = [...definitions.filter((t) => t.id !== task.id), task];
  // Only start a live croner job in polling mode; webhook mode is fired externally.
  if (config.mode === "polling") startTask(task);
  persist();
  console.log(`[scheduler] Added task: ${task.name} (${task.cron})`);
}

export function removeTask(taskId: string): boolean {
  const existed = definitions.some((t) => t.id === taskId);
  definitions = definitions.filter((t) => t.id !== taskId);
  const entry = tasks.get(taskId);
  if (entry) {
    entry.job.stop();
    tasks.delete(taskId);
  }
  if (!existed && !entry) return false;
  persist();
  console.log(`[scheduler] Removed task: ${taskId}`);
  return true;
}

export function listTasks(): ScheduledTask[] {
  return definitions;
}

function startTask(task: ScheduledTask): void {
  const job = new Cron(task.cron, { timezone: config.timezone }, () => executeTask(task));
  tasks.set(task.id, { task, job });
}

function persist(): void {
  // definitions is the authoritative task list in both modes; add/remove keep it
  // in sync with the live croner jobs (polling mode) before this is called.
  saveToDisk(definitions);
}

function loadFromDisk(): ScheduledTask[] {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, "utf-8")) as ScheduledTask[];
  } catch (err) {
    console.warn("[scheduler] Failed to read schedule file:", (err as Error).message);
    return [];
  }
}

function saveToDisk(all: ScheduledTask[]): void {
  try {
    writeJsonAtomic(SCHEDULE_FILE, all);
  } catch (err) {
    console.warn("[scheduler] Failed to persist schedule file:", (err as Error).message);
  }
}
