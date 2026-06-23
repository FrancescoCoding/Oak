#!/usr/bin/env node
/**
 * notion.mjs — a thin Notion REST helper for the coach.
 *
 * The Notion MCP server only writes paragraph and bulleted-list blocks and only
 * to page parents, which makes rich pages and database logging impossible
 * through it. This wraps the REST API so skills get, via Bash:
 *
 *   - rich block writing (headings, callouts, dividers, tables, lists)
 *   - logging a row into a database (the most common task)
 *   - querying recent rows (e.g. last 3 sessions for a Focus)
 *   - resolving + caching database ids so they survive between sessions
 *
 * Auth: NOTION_TOKEN (the same internal integration token the MCP server uses).
 *
 * Note: Notion's public API cannot create or configure database *views*
 * (grouping, default filters). That is a platform limitation, not fixable here;
 * the default-view setup still has to be done once by hand in Notion.
 *
 * Usage:
 *   node scripts/notion.mjs resolve-db --name "Workout Log"
 *   node scripts/notion.mjs query-recent --db "Workout Log" --focus Push --limit 3
 *   node scripts/notion.mjs log --db "Workout Log" \
 *        --set "Session=Push A" --set "Focus=Push" --set "Date=2026-06-23" \
 *        --set "RPE=8" --set "Exercises=Bench 5x5 @60kg; OHP 3x8 @40kg"
 *   node scripts/notion.mjs append --page <pageId> --md "# Heading\n> [!note] callout\n---\n- a\n- b"
 *   node scripts/notion.mjs append --page <pageId> --file plan.md
 */
import fs from "node:fs";
import path from "node:path";

const TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = process.env.NOTION_VERSION ?? "2022-06-28";
const API = "https://api.notion.com/v1";
const CACHE_FILE = path.resolve(process.cwd(), "data", "notion-ids.json");

if (!TOKEN) {
  console.error("NOTION_TOKEN is not set. Notion is not configured.");
  process.exit(1);
}

// ─── arg parsing (supports repeated --set) ──────────────────────────────────
function parseArgs(argv) {
  const args = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next === undefined || next.startsWith("--") ? true : (i++, next);
    if (key === "set") args.set.push(val);
    else args[key] = val;
  }
  return args;
}

async function notion(pathname, method = "GET", body) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Notion ${method} ${pathname} -> ${res.status}: ${json.message ?? ""}`);
  }
  return json;
}

// ─── id cache ────────────────────────────────────────────────────────────────
function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/** Accept a raw id or a database name; resolve names via cache then search. */
async function resolveDbId(dbRef) {
  if (!dbRef) throw new Error("--db is required (id or database name)");
  // A 32-hex (optionally dashed) string is already an id.
  if (/^[0-9a-f]{32}$/i.test(dbRef.replace(/-/g, ""))) return dbRef;

  const cache = readCache();
  if (cache[dbRef]) return cache[dbRef];

  const found = await notion("/search", "POST", {
    query: dbRef,
    filter: { value: "database", property: "object" },
  });
  const match =
    found.results?.find((r) => {
      const title = (r.title ?? []).map((t) => t.plain_text).join("");
      return title.toLowerCase() === dbRef.toLowerCase();
    }) ?? found.results?.[0];
  if (!match) throw new Error(`No database found matching "${dbRef}"`);
  cache[dbRef] = match.id;
  writeCache(cache);
  return match.id;
}

// ─── property value coercion based on the db schema ──────────────────────────
function buildPropertyValue(type, raw) {
  switch (type) {
    case "title":
      return { title: [{ text: { content: raw } }] };
    case "rich_text":
      return { rich_text: [{ text: { content: raw } }] };
    case "number":
      return { number: Number(raw) };
    case "select":
      return { select: { name: raw } };
    case "status":
      return { status: { name: raw } };
    case "multi_select":
      return { multi_select: raw.split(",").map((name) => ({ name: name.trim() })) };
    case "date":
      return { date: { start: raw } };
    case "checkbox":
      return { checkbox: /^(true|yes|1)$/i.test(raw) };
    case "url":
      return { url: raw };
    default:
      // Fall back to rich_text so we never silently drop data.
      return { rich_text: [{ text: { content: raw } }] };
  }
}

async function buildProperties(dbId, sets) {
  const db = await notion(`/databases/${dbId}`);
  const schema = db.properties ?? {};
  const props = {};
  for (const pair of sets) {
    const idx = pair.indexOf("=");
    if (idx === -1) throw new Error(`--set must be "Name=value", got "${pair}"`);
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1);
    const def = schema[name];
    if (!def) throw new Error(`Property "${name}" not found in database. Have: ${Object.keys(schema).join(", ")}`);
    props[name] = buildPropertyValue(def.type, value);
  }
  return props;
}

// ─── markdown -> Notion blocks ───────────────────────────────────────────────
function rt(text) {
  return [{ type: "text", text: { content: text } }];
}

/** Minimal but useful converter: headings, callouts, dividers, lists, tables, paragraphs. */
function markdownToBlocks(md) {
  const lines = md.replace(/\\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") { i++; continue; }

    // Column layout. Syntax:
    //   ::: columns
    //   <markdown for column 1>
    //   |||
    //   <markdown for column 2>
    //   :::
    // Columns are separated by a line of "|||" and the block ends at ":::".
    if (trimmed === "::: columns" || trimmed === ":::columns") {
      i++;
      const colSources = [[]];
      while (i < lines.length && lines[i].trim() !== ":::") {
        if (lines[i].trim() === "|||") colSources.push([]);
        else colSources[colSources.length - 1].push(lines[i]);
        i++;
      }
      i++; // skip closing ":::"
      // Notion requires at least two columns; recurse to build each column's blocks.
      const columns = colSources
        .map((src) => markdownToBlocks(src.join("\n")))
        .filter((children) => children.length > 0);
      if (columns.length >= 2) {
        blocks.push({
          object: "block",
          type: "column_list",
          column_list: {
            children: columns.map((children) => ({
              object: "block",
              type: "column",
              column: { children },
            })),
          },
        });
      } else if (columns.length === 1) {
        // Degrade gracefully to a plain stack rather than failing.
        blocks.push(...columns[0]);
      }
      continue;
    }

    if (trimmed === "---" || trimmed === "***") {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++; continue;
    }

    // Callout: "> [!note] text" or "> [icon] text" or plain "> text"
    const callout = trimmed.match(/^>\s*(?:\[!?([^\]]+)\]\s*)?(.*)$/);
    if (callout) {
      const icon = (callout[1] ?? "").trim();
      const emoji = /\p{Emoji}/u.test(icon) ? icon : "💡";
      blocks.push({
        object: "block",
        type: "callout",
        callout: { rich_text: rt(callout[2] ?? ""), icon: { type: "emoji", emoji } },
      });
      i++; continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const type = `heading_${level}`;
      blocks.push({ object: "block", type, [type]: { rich_text: rt(heading[2]) } });
      i++; continue;
    }

    // Table: consecutive "| a | b |" lines (a separator row like |---|---| is skipped)
    if (/^\|.*\|$/.test(trimmed)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) rows.push(cells);
        i++;
      }
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        blocks.push({
          object: "block",
          type: "table",
          table: {
            table_width: width,
            has_column_header: true,
            has_row_header: false,
            children: rows.map((r) => ({
              object: "block",
              type: "table_row",
              table_row: {
                cells: Array.from({ length: width }, (_, c) => rt(r[c] ?? "")),
              },
            })),
          },
        });
      }
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: rt(bullet[1]) },
      });
      i++; continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: rt(numbered[1]) },
      });
      i++; continue;
    }

    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: rt(trimmed) } });
    i++;
  }
  return blocks;
}

// ─── commands ────────────────────────────────────────────────────────────────
async function cmdResolveDb(args) {
  const id = await resolveDbId(args.name ?? args.db);
  console.log(id);
}

async function cmdQueryRecent(args) {
  const dbId = await resolveDbId(args.db);
  const limit = Number.parseInt(args.limit ?? "3", 10);
  const db = await notion(`/databases/${dbId}`);
  const schema = db.properties ?? {};
  const dateProp = Object.keys(schema).find((k) => schema[k].type === "date");
  const body = { page_size: limit };
  if (dateProp) body.sorts = [{ property: dateProp, direction: "descending" }];
  if (args.focus) body.filter = { property: "Focus", select: { equals: args.focus } };

  const res = await notion(`/databases/${dbId}/query`, "POST", body);
  if (!res.results?.length) {
    console.log("No matching rows.");
    return;
  }

  // Resolve property names from the actual schema so this adapts to any database
  // (e.g. "RPE (1-10)" vs "RPE"), rather than assuming fixed names.
  const titleProp = Object.keys(schema).find((k) => schema[k].type === "title");
  const byName = (needle) =>
    Object.keys(schema).find((k) => k.toLowerCase().includes(needle));
  const focusProp = byName("focus");
  const rpeProp = byName("rpe");
  const exProp = byName("exercise");

  const get = (name) => {
    const v = name ? p[name] : null;
    return readValue(v);
    function readValue(v) {
      if (!v) return "";
      if (v.type === "title") return v.title.map((t) => t.plain_text).join("");
      if (v.type === "rich_text") return v.rich_text.map((t) => t.plain_text).join("");
      if (v.type === "select") return v.select?.name ?? "";
      if (v.type === "status") return v.status?.name ?? "";
      if (v.type === "multi_select") return v.multi_select.map((s) => s.name).join(", ");
      if (v.type === "number") return v.number ?? "";
      if (v.type === "date") return v.date?.start ?? "";
      return "";
    }
  };

  let p;
  for (const page of res.results) {
    p = page.properties ?? {};
    const parts = [get(dateProp), get(titleProp)];
    if (focusProp) parts.push(`Focus: ${get(focusProp)}`);
    if (rpeProp) parts.push(`RPE: ${get(rpeProp)}`);
    console.log(`- ${parts.filter(Boolean).join(" | ")}`);
    if (exProp && get(exProp)) console.log(`    ${get(exProp)}`);
  }
}

async function cmdLog(args) {
  const dbId = await resolveDbId(args.db);
  const properties = await buildProperties(dbId, args.set);
  const page = await notion("/pages", "POST", { parent: { database_id: dbId }, properties });
  console.log(`Logged row ${page.id}`);
}

async function cmdAppend(args) {
  if (!args.page) throw new Error("--page <blockOrPageId> is required");
  const md = args.file ? fs.readFileSync(args.file, "utf8") : (args.md ?? "");
  if (!md.trim()) throw new Error("Nothing to append: pass --md or --file");
  const blocks = markdownToBlocks(md);
  // Notion caps children at 100 per request; chunk to be safe.
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${args.page}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  console.log(`Appended ${blocks.length} block(s) to ${args.page}`);
}

/**
 * Refresh a Dashboard tile: replace all of a column's children with fresh content.
 * Never edit blocks in place (their ids shift); always replace the whole tile.
 * Target the column by --column <id> or by --tile <thisWeek|goals|bodyStats>,
 * which is resolved from the cached Dashboard column ids.
 */
async function cmdRefreshTile(args) {
  let columnId = args.column;
  if (!columnId && args.tile) {
    const cols = readCache().__dashboard?.columns ?? {};
    columnId = cols[args.tile];
    if (!columnId) {
      throw new Error(
        `No cached column for tile "${args.tile}". Run setup-workspace.mjs first, or pass --column <id>.`,
      );
    }
  }
  if (!columnId) throw new Error("Pass --tile <name> or --column <id>");
  const md = args.file ? fs.readFileSync(args.file, "utf8") : (args.md ?? "");
  if (!md.trim()) throw new Error("Nothing to write: pass --md or --file");

  const existing = await notion(`/blocks/${columnId}/children`);
  for (const b of existing.results ?? []) await notion(`/blocks/${b.id}`, "DELETE");
  const blocks = markdownToBlocks(md);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${columnId}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  console.log(`Refreshed tile ${args.tile ?? columnId} with ${blocks.length} block(s)`);
}

const COMMANDS = {
  "resolve-db": cmdResolveDb,
  "query-recent": cmdQueryRecent,
  log: cmdLog,
  append: cmdAppend,
  "refresh-tile": cmdRefreshTile,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`Unknown command "${command}". Use one of: ${Object.keys(COMMANDS).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  await fn(parseArgs(rest));
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
