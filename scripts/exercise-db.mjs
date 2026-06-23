#!/usr/bin/env node
/**
 * exercise-db.mjs: query a free, keyless exercise database for the coach.
 *
 * Data source: free-exercise-db (https://github.com/yuhonas/free-exercise-db),
 * a static JSON dataset of ~870 exercises with muscles, equipment, level,
 * instructions, and demo images. No API key, no signup. The whole dataset is a
 * single ~1MB file, so we download it once and cache it locally, then filter
 * in-process. Override the source with EXERCISE_DB_URL if you self-host a copy.
 *
 * Usage:
 *   node scripts/exercise-db.mjs [--muscle chest] [--equipment dumbbell]
 *        [--level beginner] [--category strength] [--name "press"]
 *        [--limit 8] [--json] [--refresh]
 *
 * Filters are ANDed. --muscle matches primary or secondary muscles.
 * Equipment/muscle/level/category match loosely (substring, case-insensitive).
 * Default output is compact text; --json prints full records.
 */
import fs from "node:fs";
import path from "node:path";

const DATA_URL =
  process.env.EXERCISE_DB_URL ??
  "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json";
const IMAGE_BASE =
  process.env.EXERCISE_DB_IMAGE_BASE ??
  "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";
const CACHE_FILE = path.resolve(process.cwd(), "data", "exercises.json");
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true; // boolean flag
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function cacheFresh() {
  try {
    const stat = fs.statSync(CACHE_FILE);
    return Date.now() - stat.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

async function loadDataset({ refresh }) {
  if (!refresh && cacheFresh()) {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  }
  const res = await fetch(DATA_URL);
  if (!res.ok) {
    // Fall back to a stale cache if the network is down.
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
    throw new Error(`Failed to fetch exercise dataset: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  return data;
}

const has = (haystack, needle) =>
  String(haystack ?? "").toLowerCase().includes(String(needle).toLowerCase());

function matches(ex, f) {
  if (f.muscle) {
    const muscles = [...(ex.primaryMuscles ?? []), ...(ex.secondaryMuscles ?? [])];
    if (!muscles.some((m) => has(m, f.muscle))) return false;
  }
  if (f.equipment && !has(ex.equipment, f.equipment)) return false;
  if (f.level && !has(ex.level, f.level)) return false;
  if (f.category && !has(ex.category, f.category)) return false;
  if (f.name && !has(ex.name, f.name)) return false;
  return true;
}

function summarize(ex) {
  const imgs = ex.images ?? [];
  // Every record carries exactly two stills: 0 = start position, 1 = end position.
  return {
    name: ex.name,
    equipment: ex.equipment,
    level: ex.level,
    primaryMuscles: ex.primaryMuscles,
    secondaryMuscles: ex.secondaryMuscles,
    category: ex.category,
    instructions: ex.instructions,
    images: {
      start: imgs[0] ? IMAGE_BASE + imgs[0] : null,
      end: imgs[1] ? IMAGE_BASE + imgs[1] : null,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Number.parseInt(args.limit ?? "8", 10);
  const dataset = await loadDataset({ refresh: Boolean(args.refresh) });
  const filtered = dataset.filter((ex) => matches(ex, args)).slice(0, limit);

  if (filtered.length === 0) {
    console.log("No exercises matched. Loosen filters or check spelling.");
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(filtered.map(summarize), null, 2));
    return;
  }

  for (const ex of filtered) {
    const s = summarize(ex);
    const muscles = [...(s.primaryMuscles ?? [])].join(", ");
    console.log(`- ${s.name} (${s.equipment}, ${s.level}): ${muscles}`);
    if (s.instructions?.[0]) console.log(`    ${s.instructions[0]}`);
    if (s.images.start) console.log(`    start: ${s.images.start}`);
    if (s.images.end) console.log(`    end:   ${s.images.end}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
