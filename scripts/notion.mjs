#!/usr/bin/env node
/**
 * notion.mjs: the coach's Notion REST helper.
 *
 * Notion is reached entirely through the REST API (there is no MCP server): the
 * API does everything (rich blocks, tables, columns, database rows, page icons),
 * so this single code path keeps pages well structured. This wraps it so skills
 * get, via Bash:
 *
 *   - rich block writing (headings, callouts, dividers, tables, lists), with
 *     inline **bold**, _italic_, `code`, and [links](url) rendered as rich text
 *   - logging a row into a database (the most common task)
 *   - querying recent rows (e.g. last 3 sessions for a Focus)
 *   - resolving + caching database ids so they survive between sessions, with a
 *     self-healing cache (a stale id from a deleted/recreated db is re-resolved)
 *
 * Requests automatically retry with backoff on Notion's rate limit (HTTP 429,
 * approx 3 req/s per integration) and on transient 5xx responses.
 *
 * Auth: NOTION_TOKEN (the internal integration token).
 *
 * Note: Notion's public API cannot create or configure database *views*
 * (grouping, default filters). That is a platform limitation, not fixable here;
 * the default-view setup still has to be done once by hand in Notion.
 *
 * Usage:
 *   node scripts/notion.mjs resolve-workspace        # rebuild the id cache from the pinned Hub
 *   node scripts/notion.mjs resolve-db --name "Workout Log"
 *   node scripts/notion.mjs query-recent --db "Workout Log" --focus Push --limit 3
 *   node scripts/notion.mjs log --db "Workout Log" \
 *        --set "Session=Push A" --set "Focus=Push" --set "Date=2026-06-23" \
 *        --set "RPE=8" --set "Exercises=Bench 5x5 @60kg; OHP 3x8 @40kg"
 *   node scripts/notion.mjs append --page <pageId> --md "# Heading\n> [!note] callout\n---\n- a\n- b"
 *   node scripts/notion.mjs append --page <pageId> --file plan.md
 *   node scripts/notion.mjs sync-dashboard --now 2026-06-30
 *
 * Add --dry-run to `log` to validate and print the parsed row without writing it.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = process.env.NOTION_VERSION ?? "2022-06-28";
const API = "https://api.notion.com/v1";
const CACHE_FILE = path.resolve(process.cwd(), "data", "notion-ids.json");

// Retry tuning for rate limits (429) and transient 5xx responses.
const MAX_RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function notion(pathname, method, body) {
  if (!TOKEN) throw new Error("NOTION_TOKEN is not set. Notion is not configured.");

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // Rate limited (429) or a transient server error: back off and retry.
    // Notion sets Retry-After (seconds) on a 429; otherwise use exponential
    // backoff capped at 8s. Give up after MAX_RETRIES and fall through to the
    // normal error handling below.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt, 8) * 1000;
      await sleep(waitMs);
      continue;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Notion ${method} ${pathname} -> ${res.status}: ${json.message ?? ""}`);
    }
    return json;
  }
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
  // Atomic write: a crash mid-write must not truncate the cache to invalid JSON
  // (which readCache would silently swallow as {}, losing every resolved id and
  // causing duplicate databases on the next setup). Write to a temp file and
  // rename, which is atomic on the same filesystem.
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_FILE);
}

// ─── Hub scoping ─────────────────────────────────────────────────────────────
// Notion ids compare equal with or without dashes and regardless of case.
const normId = (id) => (id ?? "").replace(/-/g, "").toLowerCase();

// The pinned Hub (root) page. Every workspace object hangs directly off it, so
// scoping name resolution to the Hub's children means a shared integration that
// can see *other* Notion spaces (e.g. a demo workspace) can never resolve to a
// stranger's database of the same name. Resolution order: id cache, then the
// NOTION_PARENT_PAGE_ID env var, then config/notion-hub.json (a committable pin
// that survives deployments where the gitignored data/ cache starts empty).
const HUB_PIN_FILE = path.resolve(process.cwd(), "config", "notion-hub.json");
function hubId() {
  const cache = readCache();
  let pinned;
  try {
    pinned = JSON.parse(fs.readFileSync(HUB_PIN_FILE, "utf8")).hubPageId;
  } catch {
    /* no pin file; env or cache must carry it */
  }
  return normId(cache.__hub ?? process.env.NOTION_PARENT_PAGE_ID ?? pinned ?? "");
}

/** Paginated list of a block's (or page's) children. */
async function listChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const res = await notion(`/blocks/${blockId}/children${qs}`);
    out.push(...(res.results ?? []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** Accept a raw id or a database name; resolve names via cache, then by walking
 *  the pinned Hub's children. The Hub walk is the primary fallback because every
 *  workspace database hangs directly off the Hub and block-children listing is
 *  strongly consistent; Notion's /search API is eventually-consistent and often
 *  returns nothing for integration tokens (a fresh deployment with an empty
 *  data/ cache would then wrongly conclude the workspace is empty). Search is
 *  only used when no Hub is pinned at all. */
async function resolveDbId(dbRef) {
  if (!dbRef) throw new Error("--db is required (id or database name)");
  // A 32-hex (optionally dashed) string is already an id.
  if (/^[0-9a-f]{32}$/i.test(dbRef.replace(/-/g, ""))) return dbRef;

  const cache = readCache();
  if (cache[dbRef]) {
    // Validate the cached id still resolves. If the database was deleted and
    // recreated in Notion, the cached id is stale (404s); drop it and re-resolve
    // by name below, so the cache self-heals rather than needing a manual clear.
    // Also confirm it still lives under the pinned Hub: a database moved out of
    // the workspace must not keep being written to via a stale cache entry.
    try {
      const db = await notion(`/databases/${cache[dbRef]}`);
      const hub = hubId();
      if (hub && normId(db.parent?.page_id) !== hub) {
        throw new Error(`cached "${dbRef}" no longer lives under the Hub`);
      }
      return cache[dbRef];
    } catch {
      delete cache[dbRef];
      writeCache(cache);
    }
  }

  const hub = hubId();
  let candidates;
  if (hub) {
    // Deterministic: enumerate the Hub's direct children. A child_database
    // block's id IS the database id.
    candidates = (await listChildren(hub))
      .filter((b) => b.type === "child_database")
      .map((b) => ({ id: b.id, name: b.child_database?.title ?? "" }));
  } else {
    const found = await notion("/search", "POST", {
      query: dbRef,
      filter: { value: "database", property: "object" },
    });
    candidates = (found.results ?? []).map((r) => ({
      id: r.id,
      name: (r.title ?? []).map((t) => t.plain_text).join(""),
    }));
  }

  const exact = candidates.filter((r) => r.name.toLowerCase() === dbRef.toLowerCase());

  // Refuse to guess when the name is ambiguous within the Hub: picking one would
  // risk showing the wrong workspace's data. Fail loud so the user repins/cleans.
  if (exact.length > 1) {
    throw new Error(
      `Ambiguous: ${exact.length} databases named "${dbRef}" under the Hub. Run scripts/setup-workspace.mjs to repin ids, or unshare the duplicate in Notion.`,
    );
  }

  // Only ever fall back to a lone candidate when there is NO Hub pin at all
  // (single-space integration); with a Hub set, an exact title match is required.
  const match = exact[0] ?? (!hub && candidates.length === 1 ? candidates[0] : undefined);
  if (!match) {
    throw new Error(
      hub
        ? `No database named "${dbRef}" found under the pinned Hub. Run setup-workspace.mjs, or confirm the integration is shared with the Hub page.`
        : `No unambiguous database matching "${dbRef}". Set NOTION_PARENT_PAGE_ID (the Hub page id) so resolution can be scoped to your workspace.`,
    );
  }
  cache[dbRef] = match.id;
  writeCache(cache);
  return match.id;
}

/**
 * Resolve the Dashboard page and its Row 1 tile columns, self-healing from the
 * pinned Hub when the cache is empty (fresh deployment) or stale (rebuilt page).
 * Mirrors captureRow1Columns in setup-workspace.mjs: the first column_list on
 * the Dashboard holds, in order, the This Week / Goals / Body Stats tiles.
 */
const TILE_ROWS = [
  ["thisWeek", "goals", "bodyStats"],
  ["nextSession", "activeProgram"],
  ["nutrition", "quickCommands"],
];

async function resolveDashboard(force = false) {
  const cached = readCache().__dashboard;
  if (!force && cached?.pageId && cached?.columns?.thisWeek) {
    try {
      await notion(`/blocks/${cached.columns.thisWeek}`);
      return cached;
    } catch {
      /* stale (page rebuilt or deleted); re-resolve from the Hub below */
    }
  }

  const hub = hubId();
  if (!hub) {
    throw new Error(
      "No Dashboard cached and no Hub pinned. Set NOTION_PARENT_PAGE_ID or config/notion-hub.json, or run setup-workspace.mjs.",
    );
  }
  const page = (await listChildren(hub)).find(
    (b) => b.type === "child_page" && b.child_page?.title === "Dashboard",
  );
  if (!page) {
    throw new Error("No Dashboard page found under the Hub. Run setup-workspace.mjs to build it.");
  }
  const lists = (await listChildren(page.id)).filter((b) => b.type === "column_list");
  const columns = { listId: lists[0]?.id };
  for (let r = 0; r < lists.length && r < TILE_ROWS.length; r++) {
    const ids = (await listChildren(lists[r].id)).map((c) => c.id);
    TILE_ROWS[r].forEach((name, i) => {
      if (ids[i]) columns[name] = ids[i];
    });
  }
  const dash = { pageId: page.id, columns };
  const cache = readCache();
  cache.__dashboard = dash;
  writeCache(cache);
  return dash;
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

/** The allowed option names for a select/multi_select/status property, else null. */
function optionNames(def) {
  if (def.type === "select") return (def.select?.options ?? []).map((o) => o.name);
  if (def.type === "status") return (def.status?.options ?? []).map((o) => o.name);
  if (def.type === "multi_select") return (def.multi_select?.options ?? []).map((o) => o.name);
  return null;
}

/**
 * Validate a --set value against the live schema before it is written, so a
 * miscategorised or out-of-range value fails locally with the valid options
 * (the same self-correcting pattern as the unknown-property check) instead of
 * silently creating a stray select option or logging an impossible number.
 * Pure (no I/O) so it is unit-testable; throws on the first problem.
 */
function validateValue(name, def, value) {
  const allowed = optionNames(def);
  if (allowed) {
    const given = def.type === "multi_select" ? value.split(",").map((v) => v.trim()) : [value];
    for (const v of given) {
      if (v && !allowed.includes(v)) {
        throw new Error(
          `"${v}" is not a valid option for "${name}". Allowed: ${allowed.join(", ")}`,
        );
      }
    }
  }
  if (def.type === "number") {
    const n = Number(value);
    if (value !== "" && Number.isNaN(n)) {
      throw new Error(`Property "${name}" expects a number, got "${value}".`);
    }
    // RPE is a fixed 1-10 scale; reject impossible values rather than logging them.
    if (/\brpe\b/i.test(name) && (n < 1 || n > 10)) {
      throw new Error(`"${name}" must be between 1 and 10, got ${value}.`);
    }
  }
}

/**
 * Resolve a relation value to related page ids. Accepts a raw page id, or a row
 * title looked up in the related database (the title property's id is always
 * "title", so the filter works regardless of the property's display name).
 */
async function resolveRelationIds(def, value) {
  const ref = value.trim();
  if (!ref) return [];
  if (/^[0-9a-f]{32}$/i.test(ref.replace(/-/g, ""))) return [{ id: ref }];
  const relDb = def.relation?.database_id;
  if (!relDb) throw new Error("Relation property has no related database id.");
  const res = await notion(`/databases/${relDb}/query`, "POST", {
    filter: { property: "title", title: { equals: ref } },
    page_size: 2,
  });
  const rows = res.results ?? [];
  if (rows.length === 0) {
    // Self-correcting error: list the real row titles so the caller can retry
    // with an exact match (same pattern as the unknown-property message).
    const all = await notion(`/databases/${relDb}/query`, "POST", { page_size: 25 });
    const titles = (all.results ?? [])
      .map((p) => {
        const t = Object.values(p.properties ?? {}).find((v) => v.type === "title");
        return (t?.title ?? []).map((x) => x.plain_text).join("");
      })
      .filter(Boolean);
    throw new Error(
      `No row titled "${ref}" in the related database. Have: ${titles.join(", ") || "(no rows)"}`,
    );
  }
  if (rows.length > 1) throw new Error(`Ambiguous: multiple rows titled "${ref}" in the related database.`);
  return [{ id: rows[0].id }];
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
    if (!def)
      throw new Error(
        `Property "${name}" not found in database. Have: ${Object.keys(schema).join(", ")}`,
      );
    if (def.type === "relation") {
      props[name] = { relation: await resolveRelationIds(def, value) };
      continue;
    }
    validateValue(name, def, value);
    props[name] = buildPropertyValue(def.type, value);
  }
  return props;
}

// ─── markdown -> Notion blocks ───────────────────────────────────────────────

// Inline markdown spans, in priority order. Code is first so its contents are
// taken literally; bold (** / __) is matched before italic (* / _) so "**x**"
// is not mistaken for two italics. Spans are non-nesting, which covers the
// common cases (bold/italic/code/link inside a line) without a full parser.
const INLINE_PATTERNS = [
  { re: /`([^`]+)`/, annotations: { code: true } },
  { re: /\[([^\]]+)\]\(([^)\s]+)\)/, link: true },
  { re: /\*\*([^*]+)\*\*/, annotations: { bold: true } },
  { re: /__([^_]+)__/, annotations: { bold: true } },
  { re: /\*([^*]+)\*/, annotations: { italic: true } },
  { re: /_([^_]+)_/, annotations: { italic: true } },
];

const plain = (content) => ({ type: "text", text: { content } });

/**
 * Parse a line of markdown into Notion rich_text objects, rendering inline
 * **bold**, _italic_, `code`, and [links](url) as annotations rather than
 * leaking literal asterisks/backticks into the page. Returns [] for empty input.
 */
function parseInline(text) {
  if (!text) return [];
  const out = [];
  let rest = text;

  while (rest.length) {
    // Find the earliest-matching span across all patterns.
    let best = null;
    for (const pat of INLINE_PATTERNS) {
      const m = pat.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { pat, m };
    }
    if (!best) {
      out.push(plain(rest));
      break;
    }
    const { pat, m } = best;
    if (m.index > 0) out.push(plain(rest.slice(0, m.index)));
    if (pat.link) {
      out.push({ type: "text", text: { content: m[1], link: { url: m[2] } } });
    } else {
      out.push({ type: "text", text: { content: m[1] }, annotations: pat.annotations });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// Block-level rich text. Always returns at least one node so a block is never
// created with empty rich_text where Notion expects content.
function rt(text) {
  const parsed = parseInline(text);
  return parsed.length ? parsed : [plain(text ?? "")];
}

// The Notion "color" values valid on a callout/text block. Anything outside this
// set is rejected so a typo silently degrades to "default" instead of erroring.
const NOTION_COLORS = new Set([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
  "gray_background",
  "brown_background",
  "orange_background",
  "yellow_background",
  "green_background",
  "blue_background",
  "purple_background",
  "pink_background",
  "red_background",
]);

/** Canonical, fixed background for each named Dashboard tile, so colors never
 * drift between refreshes. The render functions and setup-workspace.mjs both
 * use these, and refresh-tile re-applies them. Keep the two files in sync. */
const TILE_COLORS = {
  thisWeek: "gray_background",
  goals: "brown_background",
  bodyStats: "red_background",
  nutrition: "green_background",
};

/** Validate a Notion color, returning "default" for missing/unknown values. */
function normalizeColor(color) {
  const c = (color ?? "").trim();
  return NOTION_COLORS.has(c) ? c : "default";
}

/** Minimal but useful converter: headings, callouts, dividers, lists, tables, paragraphs. */
function markdownToBlocks(md) {
  const lines = md.replace(/\\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      i++;
      continue;
    }

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
      i++;
      continue;
    }

    // Callout: "> [!note] text", "> [icon] text", "> [icon|color] text", or plain "> text".
    // The optional "|color" after the icon sets the callout background (e.g.
    // "> [📅|gray_background] **This Week**"); unknown colors fall back to default.
    const callout = trimmed.match(/^>\s*(?:\[!?([^\]]+)\]\s*)?(.*)$/);
    if (callout) {
      const [iconPart, colorPart] = (callout[1] ?? "").split("|").map((s) => s.trim());
      const emoji = /\p{Emoji}/u.test(iconPart ?? "") ? iconPart : "💡";
      const color = normalizeColor(colorPart);
      blocks.push({
        object: "block",
        type: "callout",
        callout: {
          rich_text: rt(callout[2] ?? ""),
          icon: { type: "emoji", emoji },
          color,
        },
      });
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const type = `heading_${level}`;
      blocks.push({ object: "block", type, [type]: { rich_text: rt(heading[2]) } });
      i++;
      continue;
    }

    // Table: consecutive "| a | b |" lines (a separator row like |---|---| is skipped)
    if (/^\|.*\|$/.test(trimmed)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const cells = lines[i]
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
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
      i++;
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: rt(numbered[1]) },
      });
      i++;
      continue;
    }

    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: rt(trimmed) } });
    i++;
  }
  return blocks;
}

// ─── reading rows + dashboard rendering ──────────────────────────────────────

/** Read a Notion property value object into a plain string/number. */
function readProp(v) {
  if (!v) return "";
  if (v.type === "title") return (v.title ?? []).map((t) => t.plain_text).join("");
  if (v.type === "rich_text") return (v.rich_text ?? []).map((t) => t.plain_text).join("");
  if (v.type === "select") return v.select?.name ?? "";
  if (v.type === "status") return v.status?.name ?? "";
  if (v.type === "multi_select") return (v.multi_select ?? []).map((s) => s.name).join(", ");
  if (v.type === "number") return v.number ?? "";
  if (v.type === "date") return v.date?.start ?? "";
  return "";
}

/** Find a property name by a predicate over (lowercased name, definition). */
function findProp(schema, pred) {
  return Object.keys(schema).find((k) => pred(k.toLowerCase(), schema[k]));
}

const isoDate = (d) => d.toISOString().slice(0, 10);

/** Monday 00:00 UTC of the week containing d. UTC-based so it is deterministic
 *  regardless of server timezone (the caller can pass --now from the chat header). */
function startOfWeekUTC(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const mondayOffset = (x.getUTCDay() + 6) % 7; // Sun=0 -> 6, Mon=1 -> 0
  x.setUTCDate(x.getUTCDate() - mondayOffset);
  return x;
}

// Pure tile renderers: take plain extracted rows and return tile markdown. The
// numbers come straight from Notion queries (never the model), which is what
// keeps the Dashboard honest. Exported for unit tests.
function renderThisWeekTile(sessions) {
  const lines = [`> [📅|${TILE_COLORS.thisWeek}] **This Week**`];
  if (!sessions.length) {
    lines.push("- No sessions logged yet this week.");
  } else {
    lines.push(`- ${sessions.length} session${sessions.length === 1 ? "" : "s"} logged this week`);
    const last = sessions[0];
    const focus = last.focus ? ` (${last.focus})` : "";
    lines.push(`- Last: ${[last.date, last.name].filter(Boolean).join(" ")}${focus}`);
  }
  return lines.join("\n");
}

function renderGoalsTile(goals) {
  const lines = [`> [🎯|${TILE_COLORS.goals}] **Goals**`];
  const active = goals.filter((g) => g.status !== "Achieved" && g.status !== "Paused");
  const show = (active.length ? active : goals).slice(0, 5);
  if (!show.length) {
    lines.push("- No goals set yet.");
  } else {
    for (const g of show) {
      const hasNums = g.current !== "" && g.current != null && g.target !== "" && g.target != null;
      lines.push(`- ${g.goal}${hasNums ? `: ${g.current} / ${g.target}` : ""}`);
    }
  }
  return lines.join("\n");
}

function renderBodyStatsTile(latest) {
  const lines = [`> [⚖️|${TILE_COLORS.bodyStats}] **Body Stats**`];
  if (!latest) {
    lines.push("- No check-ins logged yet.");
  } else {
    const parts = [];
    if (latest.bodyweight !== "" && latest.bodyweight != null) parts.push(`${latest.bodyweight}kg`);
    if (latest.waist !== "" && latest.waist != null) parts.push(`waist ${latest.waist}cm`);
    lines.push(`- ${[latest.date, parts.join(", ")].filter(Boolean).join(": ")}`);
  }
  return lines.join("\n");
}

/**
 * Replace a column's children with fresh content, append-then-delete: write the
 * new blocks first, then delete the previously-existing ones. A failure mid-append
 * leaves the old tile intact (brief duplication) rather than wiping it to empty.
 * Returns the number of blocks written.
 */
async function replaceTileContent(columnId, md, forceColor) {
  const existing = await notion(`/blocks/${columnId}/children`);
  const oldIds = (existing.results ?? []).map((b) => b.id);
  const blocks = markdownToBlocks(md);
  // Lock the tile's header callout to its canonical color so it never drifts,
  // regardless of what color (if any) the source markdown specified.
  if (forceColor) {
    const header = blocks.find((b) => b.type === "callout");
    if (header) header.callout.color = normalizeColor(forceColor);
  }
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${columnId}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
  }
  for (const id of oldIds) await notion(`/blocks/${id}`, "DELETE");
  return blocks.length;
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
  const byName = (needle) => Object.keys(schema).find((k) => k.toLowerCase().includes(needle));
  const focusProp = byName("focus");
  const rpeProp = byName("rpe");
  const exProp = byName("exercise");

  let p;
  const get = (name) => readProp(name ? p[name] : null);
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
  // --dry-run validates and prints the parsed row without writing, so the coach
  // can read it back before committing (supports the "confirm before logging" flow).
  if (args["dry-run"]) {
    console.log("Dry run, nothing written. Parsed properties:");
    console.log(JSON.stringify(properties, null, 2));
    return;
  }
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
    let cols = (await resolveDashboard()).columns ?? {};
    // An older cache may only hold the Row 1 tiles; re-capture from the live
    // page before giving up on a Row 2/3 tile like nextSession or nutrition.
    if (!cols[args.tile]) cols = (await resolveDashboard(true)).columns ?? {};
    columnId = cols[args.tile];
    if (!columnId) {
      throw new Error(
        `No column found for tile "${args.tile}" on the Dashboard. Known tiles: ${TILE_ROWS.flat().join(", ")}. Run setup-workspace.mjs, or pass --column <id>.`,
      );
    }
  }
  if (!columnId) throw new Error("Pass --tile <name> or --column <id>");
  const md = args.file ? fs.readFileSync(args.file, "utf8") : (args.md ?? "");
  if (!md.trim()) throw new Error("Nothing to write: pass --md or --file");

  const written = await replaceTileContent(columnId, md, TILE_COLORS[args.tile]);
  console.log(`Refreshed tile ${args.tile ?? columnId} with ${written} block(s)`);
}

/**
 * Rebuild the three Row 1 Dashboard tiles (This Week, Goals, Body Stats) directly
 * from the databases, so they are always consistent with the data and never carry
 * hand-written (fabricated) numbers. The agent calls this once after any data
 * change instead of hand-building each tile. --now <YYYY-MM-DD> sets "this week"
 * from the chat header date (defaults to the system date).
 */
async function cmdSyncDashboard(args) {
  const cols = (await resolveDashboard()).columns ?? {};
  if (!cols.thisWeek && !cols.goals && !cols.bodyStats) {
    throw new Error("Dashboard has no tile columns. Run setup-workspace.mjs first.");
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now must be an ISO date, got "${args.now}"`);

  // This Week: sessions logged since Monday of the current week.
  if (cols.thisWeek) {
    const wlId = await resolveDbId("Workout Log");
    const schema = (await notion(`/databases/${wlId}`)).properties ?? {};
    const dateProp = findProp(schema, (_n, d) => d.type === "date");
    const titleProp = findProp(schema, (_n, d) => d.type === "title");
    const focusProp = findProp(schema, (n) => n.includes("focus"));
    const body = { page_size: 100 };
    if (dateProp) {
      body.filter = { property: dateProp, date: { on_or_after: isoDate(startOfWeekUTC(now)) } };
      body.sorts = [{ property: dateProp, direction: "descending" }];
    }
    const res = await notion(`/databases/${wlId}/query`, "POST", body);
    const sessions = (res.results ?? []).map((pg) => ({
      date: readProp(pg.properties?.[dateProp]),
      name: readProp(pg.properties?.[titleProp]),
      focus: focusProp ? readProp(pg.properties?.[focusProp]) : "",
    }));
    await replaceTileContent(cols.thisWeek, renderThisWeekTile(sessions), TILE_COLORS.thisWeek);
  }

  // Goals: active goals with current/target progress.
  if (cols.goals) {
    const gId = await resolveDbId("Goals");
    const schema = (await notion(`/databases/${gId}`)).properties ?? {};
    const titleProp = findProp(schema, (_n, d) => d.type === "title");
    const statusProp = findProp(schema, (n) => n.includes("status"));
    const curProp = findProp(schema, (n, d) => n.includes("current") && d.type === "number");
    const tgtProp = findProp(schema, (n, d) => n.includes("target") && d.type === "number");
    const res = await notion(`/databases/${gId}/query`, "POST", { page_size: 100 });
    const goals = (res.results ?? []).map((pg) => ({
      goal: readProp(pg.properties?.[titleProp]),
      status: statusProp ? readProp(pg.properties?.[statusProp]) : "",
      current: curProp ? readProp(pg.properties?.[curProp]) : "",
      target: tgtProp ? readProp(pg.properties?.[tgtProp]) : "",
    }));
    await replaceTileContent(cols.goals, renderGoalsTile(goals), TILE_COLORS.goals);
  }

  // Body Stats: the latest check-in.
  if (cols.bodyStats) {
    const bId = await resolveDbId("Body Stats");
    const schema = (await notion(`/databases/${bId}`)).properties ?? {};
    const dateProp = findProp(schema, (_n, d) => d.type === "date");
    const bwProp = findProp(schema, (n) => n.includes("bodyweight"));
    const waistProp = findProp(schema, (n) => n.includes("waist"));
    const body = { page_size: 1 };
    if (dateProp) body.sorts = [{ property: dateProp, direction: "descending" }];
    const res = await notion(`/databases/${bId}/query`, "POST", body);
    const row = res.results?.[0];
    const latest = row
      ? {
          date: readProp(row.properties?.[dateProp]),
          bodyweight: bwProp ? readProp(row.properties?.[bwProp]) : "",
          waist: waistProp ? readProp(row.properties?.[waistProp]) : "",
        }
      : null;
    await replaceTileContent(cols.bodyStats, renderBodyStatsTile(latest), TILE_COLORS.bodyStats);
  }

  console.log("Synced Dashboard tiles (This Week, Goals, Body Stats) from Notion.");
}

/**
 * Create a child page under a parent page (used to organise the knowledge base:
 * one subpage per imported training program). Optional markdown body and emoji.
 * Prints the new page id.
 */
async function cmdCreatePage(args) {
  if (!args.parent) throw new Error("--parent <pageId> is required");
  if (!args.title) throw new Error("--title is required");
  const body = {
    parent: { page_id: args.parent },
    properties: { title: { title: [{ text: { content: args.title } }] } },
  };
  if (args.icon) body.icon = { type: "emoji", emoji: args.icon };
  const page = await notion("/pages", "POST", body);

  const md = args.file ? fs.readFileSync(args.file, "utf8") : (args.md ?? "");
  if (md.trim()) {
    const blocks = markdownToBlocks(md);
    for (let i = 0; i < blocks.length; i += 100) {
      await notion(`/blocks/${page.id}/children`, "PATCH", { children: blocks.slice(i, i + 100) });
    }
  }
  console.log(page.id);
}

/**
 * Repopulate the whole id cache deterministically from the pinned Hub in a few
 * API calls: every child database by exact title, the Knowledge Base page, and
 * the Dashboard with its tile columns. This is the fresh-session bootstrap for
 * deployments where the gitignored data/ dir starts empty: it never touches the
 * unreliable /search API and never creates anything (unlike setup-workspace.mjs).
 */
async function cmdResolveWorkspace() {
  const hub = hubId();
  if (!hub) {
    throw new Error(
      'No Hub pinned. Set NOTION_PARENT_PAGE_ID or config/notion-hub.json ({"hubPageId": "..."}).',
    );
  }
  const kids = await listChildren(hub);
  const cache = readCache();
  cache.__hub = hub;
  const dbs = [];
  for (const b of kids) {
    if (b.type === "child_database") {
      const title = b.child_database?.title ?? "";
      if (title) {
        cache[title] = b.id;
        dbs.push(title);
      }
    }
    if (b.type === "child_page" && b.child_page?.title === "Knowledge Base") {
      cache.__knowledgeBase = b.id;
    }
  }
  writeCache(cache);
  let dashboard = "not found";
  try {
    dashboard = (await resolveDashboard(true)).pageId;
  } catch {
    /* no Dashboard page yet; setup-workspace.mjs builds it */
  }
  console.log(`Hub: ${hub}`);
  console.log(`Databases: ${dbs.join(", ") || "none"}`);
  console.log(`Knowledge Base: ${cache.__knowledgeBase ?? "not found"}`);
  console.log(`Dashboard: ${dashboard}`);
  console.log("Ids cached to data/notion-ids.json");
}

const COMMANDS = {
  "resolve-db": cmdResolveDb,
  "resolve-workspace": cmdResolveWorkspace,
  "query-recent": cmdQueryRecent,
  log: cmdLog,
  append: cmdAppend,
  "refresh-tile": cmdRefreshTile,
  "sync-dashboard": cmdSyncDashboard,
  "create-page": cmdCreatePage,
};

async function main() {
  if (!TOKEN) {
    console.error("NOTION_TOKEN is not set. Notion is not configured.");
    process.exitCode = 1;
    return;
  }
  const [command, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`Unknown command "${command}". Use one of: ${Object.keys(COMMANDS).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  await fn(parseArgs(rest));
}

// Run only when invoked directly (node scripts/notion.mjs ...), so the pure
// helpers above can be imported by the test suite without executing a command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

export {
  parseInline,
  markdownToBlocks,
  buildPropertyValue,
  validateValue,
  optionNames,
  readProp,
  startOfWeekUTC,
  renderThisWeekTile,
  renderGoalsTile,
  renderBodyStatsTile,
};
