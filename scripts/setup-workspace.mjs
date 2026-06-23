#!/usr/bin/env node
/**
 * setup-workspace.mjs: deterministic builder for the coaching Notion workspace.
 *
 * Builds, in the strict order the relations require:
 *   1. Programs DB
 *   2. Goals DB
 *   3. Body Stats DB
 *   4. Workout Log DB   (has a relation to Programs, so Programs must exist first)
 *   5. an initial Programs row (only if Programs is empty)
 *   6. Dashboard page    (3 rows of column layouts)
 *
 * Idempotent: existing databases/pages under the Hub are detected by title and
 * reused, never duplicated. All resolved ids (databases, hub, dashboard page,
 * and the Row 1 column ids used for tile updates) are written to
 * data/notion-ids.json so the agent and the notion.mjs helper can find them on
 * this instance. The committed code hardcodes no ids; they are per-workspace.
 *
 * Uses the Notion REST API directly (the MCP server cannot build this).
 *
 * Usage:
 *   node scripts/setup-workspace.mjs                 # build/repair, keep existing dashboard content
 *   node scripts/setup-workspace.mjs --rebuild-dashboard
 *   node scripts/setup-workspace.mjs --hub <pageId>  # override NOTION_PARENT_PAGE_ID
 */
import fs from "node:fs";
import path from "node:path";

const TOKEN = process.env.NOTION_TOKEN;
const API = "https://api.notion.com/v1";
const CACHE_FILE = path.resolve(process.cwd(), "data", "notion-ids.json");

if (!TOKEN) {
  console.error("NOTION_TOKEN is not set. Notion is not configured.");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

const HUB = opt("hub") ?? process.env.NOTION_PARENT_PAGE_ID;
if (!HUB) {
  console.error("No Hub page id. Set NOTION_PARENT_PAGE_ID or pass --hub <pageId>.");
  process.exit(1);
}

async function api(pathname, method = "GET", body) {
  const res = await fetch(`${API}/${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${method} ${pathname} -> ${res.status}: ${json.message ?? ""}`);
  return json;
}

// ─── cache ───────────────────────────────────────────────────────────────────
function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}
function writeCache(c) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
}
const cache = readCache();

// ─── block helpers (from the build spec) ─────────────────────────────────────
const RT = (t) => [{ type: "text", text: { content: t } }];
const RTb = (t) => [{ type: "text", text: { content: t }, annotations: { bold: true } }];
const h2 = (t) => ({ type: "heading_2", heading_2: { rich_text: RT(t) } });
const h3 = (t) => ({ type: "heading_3", heading_3: { rich_text: RT(t) } });
const p = (t) => ({ type: "paragraph", paragraph: { rich_text: RT(t) } });
const bul = (t) => ({ type: "bulleted_list_item", bulleted_list_item: { rich_text: RT(t) } });
const div = () => ({ type: "divider", divider: {} });
const pe = () => ({ type: "paragraph", paragraph: { rich_text: [] } });
const box = (t, e, c = "default") => ({
  type: "callout",
  callout: { rich_text: RT(t), icon: { type: "emoji", emoji: e }, color: c },
});
const q = (t) => ({ type: "quote", quote: { rich_text: RT(t) } });
// Column layout: children go INSIDE column_list, each column needs >=1 block.
const colList = (...columns) => ({
  type: "column_list",
  column_list: {
    children: columns.map((blocks) => ({
      type: "column",
      column: { children: blocks.length ? blocks : [pe()] },
    })),
  },
});
async function append(parentId, blocks) {
  for (let i = 0; i < blocks.length; i += 90) {
    await api(`blocks/${parentId}/children`, "PATCH", { children: blocks.slice(i, i + 90) });
  }
}

// ─── discovery / idempotency ─────────────────────────────────────────────────
/** Map of child databases under the Hub: lowercased title -> id. */
async function hubChildDatabases() {
  const map = {};
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const res = await api(`blocks/${HUB}/children${qs}`);
    for (const b of res.results ?? []) {
      if (b.type === "child_database") map[(b.child_database?.title ?? "").toLowerCase()] = b.id;
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return map;
}

/** First child page under the Hub with the given title, or null. */
async function findHubChildPage(title) {
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const res = await api(`blocks/${HUB}/children${qs}`);
    for (const b of res.results ?? []) {
      if (b.type === "child_page" && (b.child_page?.title ?? "") === title) return b.id;
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return null;
}

async function ensureDatabase(title, properties, existing) {
  const found = existing[title.toLowerCase()];
  if (found) {
    console.log(`= ${title} exists (${found})`);
    return found;
  }
  const db = await api("databases", "POST", {
    parent: { type: "page_id", page_id: HUB },
    title: [{ type: "text", text: { content: title } }],
    properties,
  });
  console.log(`+ created ${title} (${db.id})`);
  return db.id;
}

const sel = (...names) => ({ select: { options: names.map((name) => ({ name })) } });
const multi = (...names) => ({ multi_select: { options: names.map((name) => ({ name })) } });

// ─── build ───────────────────────────────────────────────────────────────────
async function main() {
  cache.__hub = HUB;
  const existing = await hubChildDatabases();

  // 1. Programs
  const programs = await ensureDatabase("Programs", {
    Program: { title: {} },
    Type: sel("Powerbuilding", "Strength", "Hypertrophy", "Cardio", "Deload"),
    Status: sel("Active", "Completed", "Planned", "Paused"),
    "Start Date": { date: {} },
    "End Date": { date: {} },
    Weeks: { number: {} },
    Notes: { rich_text: {} },
  }, existing);
  cache.Programs = programs;

  // 2. Goals
  cache.Goals = await ensureDatabase("Goals", {
    Goal: { title: {} },
    Category: sel("Strength", "Body Composition", "Cardio", "Habit"),
    Metric: { rich_text: {} },
    "Starting Value": { number: {} },
    "Current Value": { number: {} },
    "Target Value": { number: {} },
    "Target Date": { date: {} },
    Status: sel("On track", "At risk", "Achieved", "Paused"),
  }, existing);

  // 3. Body Stats
  cache["Body Stats"] = await ensureDatabase("Body Stats", {
    "Check-in": { title: {} },
    Date: { date: {} },
    "Bodyweight (kg)": { number: {} },
    "Waist (cm)": { number: {} },
    "Chest (cm)": { number: {} },
    "Arm (cm)": { number: {} },
    Conditions: sel("Morning fasted", "Evening", "After holiday", "Post-training"),
    Notes: { rich_text: {} },
  }, existing);

  // 4. Workout Log (relation to Programs, which must already exist)
  cache["Workout Log"] = await ensureDatabase("Workout Log", {
    Session: { title: {} },
    Date: { date: {} },
    Week: sel("Week 1", "Week 2", "Week 3", "Week 4", "Week 5", "Week 6", "Week 7", "Week 8"),
    Day: sel("Monday", "Wednesday", "Friday", "Saturday", "Sunday"),
    Focus: multi("Legs", "Chest", "Back", "Shoulders", "Biceps", "Triceps", "Cardio", "Full Body", "Mobility"),
    Status: sel("Completed", "Partial", "Skipped"),
    "Top Set": { number: {} },
    "Volume (kg)": { number: {} },
    "Duration (min)": { number: {} },
    "RPE (1-10)": { number: {} },
    Program: { relation: { database_id: programs, type: "single_property", single_property: {} } },
  }, existing);

  // 5. Initial program row, only if Programs is empty.
  const progRows = await api(`databases/${programs}/query`, "POST", { page_size: 1 });
  if (!progRows.results?.length) {
    await api("pages", "POST", {
      parent: { database_id: programs },
      properties: {
        Program: { title: RT("Current Program") },
        Type: { select: { name: "Powerbuilding" } },
        Status: { select: { name: "Active" } },
      },
    });
    console.log("+ seeded initial Programs row");
  } else {
    console.log("= Programs already has rows");
  }

  // 6. Dashboard page.
  await ensureDashboard();

  // 7. Knowledge Base page: where dumped training programs are organised.
  await ensureKnowledgeBase();

  writeCache(cache);
  console.log("\nWorkspace ready. Ids cached to data/notion-ids.json");
}

async function ensureDashboard() {
  let pageId = await findHubChildPage("Dashboard");
  if (!pageId) {
    const page = await api("pages", "POST", {
      parent: { type: "page_id", page_id: HUB },
      icon: { type: "emoji", emoji: "🏠" },
      properties: { title: { title: RT("Dashboard") } },
    });
    pageId = page.id;
    console.log(`+ created Dashboard page (${pageId})`);
    await buildDashboardBody(pageId);
  } else if (flag("rebuild-dashboard")) {
    console.log(`~ rebuilding Dashboard page (${pageId})`);
    // Clear existing top-level blocks, then rebuild.
    const kids = await api(`blocks/${pageId}/children`);
    for (const b of kids.results ?? []) await api(`blocks/${b.id}`, "DELETE");
    await buildDashboardBody(pageId);
  } else {
    console.log(`= Dashboard page exists (${pageId})`);
  }
  cache.__dashboard = { pageId, columns: await captureRow1Columns(pageId) };
}

async function buildDashboardBody(pageId) {
  await append(pageId, [
    box("Current Program, Week 1, started recently", "🏋️", "blue_background"),
    div(),
  ]);
  // Row 1: This Week | Goals | Body Stats
  await append(pageId, [
    colList(
      [box("This Week", "📅", "gray_background"), bul("Log a session to populate this tile.")],
      [box("Goals", "🎯", "gray_background"), bul("Add a goal to populate this tile.")],
      [box("Body Stats", "⚖️", "gray_background"), bul("Log a check-in to populate this tile.")],
    ),
    div(),
  ]);
  // Row 2: Next Session | Active Program + Coach Note
  await append(pageId, [
    colList(
      [box("Next Session", "➡️", "default"), p("Ask your coach what to train next.")],
      [box("Active Program", "📋", "default"), q("Consistency beats perfection.")],
    ),
    div(),
  ]);
  // Row 3: Nutrition | Quick Commands
  await append(pageId, [
    colList(
      [box("Nutrition", "🍽️", "green_background"), p("Daily targets appear here once set.")],
      [box("Quick Commands", "⚡", "default"), bul("what should I train today"), bul("log my session"), bul("how am I progressing")],
    ),
  ]);
}

async function ensureKnowledgeBase() {
  let pageId = await findHubChildPage("Knowledge Base");
  if (!pageId) {
    const page = await api("pages", "POST", {
      parent: { type: "page_id", page_id: HUB },
      icon: { type: "emoji", emoji: "📚" },
      properties: { title: { title: RT("Knowledge Base") } },
    });
    pageId = page.id;
    await append(pageId, [
      box("Training programs and reference material the coach draws on. Drop files in the repo's knowledge/ folder and ask the coach to import them.", "📚", "gray_background"),
      div(),
    ]);
    console.log(`+ created Knowledge Base page (${pageId})`);
  } else {
    console.log(`= Knowledge Base page exists (${pageId})`);
  }
  cache.__knowledgeBase = pageId;
}

/** Fetch the first column_list on the Dashboard and return its column ids. */
async function captureRow1Columns(pageId) {
  const top = await api(`blocks/${pageId}/children`);
  const cl = (top.results ?? []).find((b) => b.type === "column_list");
  if (!cl) return {};
  const cols = await api(`blocks/${cl.id}/children`);
  const ids = (cols.results ?? []).map((c) => c.id);
  return { listId: cl.id, thisWeek: ids[0], goals: ids[1], bodyStats: ids[2] };
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
