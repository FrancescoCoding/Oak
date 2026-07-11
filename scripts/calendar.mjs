#!/usr/bin/env node
/**
 * calendar.mjs: the coach's Google Calendar REST helper.
 *
 * Google Calendar is reached directly through its REST API with plain fetch,
 * the same pattern as scripts/notion.mjs (no SDK, no MCP server): the API is a
 * handful of JSON endpoints and OAuth2 refresh is a single POST, so one small
 * code path keeps auth storage, retries, and output format under our control.
 *
 * This is how the user gets session reminders on their phone without relying
 * on Telegram notifications: events are created with Google's own popup
 * reminders (default 30 minutes before), and recurring weekly events cover a
 * stable training schedule.
 *
 * Auth: OAuth2 refresh token minted once by scripts/google-auth.mjs.
 *   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (env, from .env)
 *   - refresh token: GOOGLE_REFRESH_TOKEN env if set (deployments, Secret
 *     Manager), otherwise data/google-token.json (local, gitignored; override
 *     the path with GOOGLE_TOKEN_FILE for mounted volumes).
 * Access tokens are cached in the token file and refreshed transparently when
 * they are within a minute of expiry, with one forced refresh retry on a 401.
 *
 * Calendar selection (first match wins): GOOGLE_CALENDAR_ID env, then the id
 * cached by `use-calendar` in data/google-calendar.json, then "primary".
 *
 * Usage:
 *   node scripts/calendar.mjs status
 *   node scripts/calendar.mjs list --from 2026-07-13 [--to 2026-07-20]
 *   node scripts/calendar.mjs create --title "Push A" \
 *        --start "2026-07-13T18:00" --end "2026-07-13T19:00" \
 *        [--description "Bench 5x5..."] [--reminders "popup:30"] \
 *        [--recurrence "RRULE:FREQ=WEEKLY;BYDAY=MO"]
 *   node scripts/calendar.mjs update --id <eventId> [--title ...] [--start ...] \
 *        [--end ...] [--description ...] [--reminders ...]
 *   node scripts/calendar.mjs delete --id <eventId>
 *   node scripts/calendar.mjs list-calendars
 *   node scripts/calendar.mjs use-calendar --name "Oak Training" [--create]
 *
 * Times without a Z/offset (e.g. 2026-07-13T18:00) are interpreted in TIMEZONE
 * (default Europe/London). A bare YYYY-MM-DD makes an all-day event.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TIMEZONE = process.env.TIMEZONE ?? "Europe/London";
const API = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_FILE = path.resolve(
  process.cwd(),
  process.env.GOOGLE_TOKEN_FILE ?? path.join("data", "google-token.json"),
);
const CALENDAR_FILE = path.resolve(process.cwd(), "data", "google-calendar.json");

const MAX_RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── arg parsing (same shape as notion.mjs) ──────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    args[key] = next === undefined || next.startsWith("--") ? true : (i++, next);
  }
  return args;
}

// ─── auth: refresh-token file and access-token minting ──────────────────────
function readTokenFile() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeTokenFile(data) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  const tmp = `${TOKEN_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, TOKEN_FILE);
}

function refreshToken() {
  return process.env.GOOGLE_REFRESH_TOKEN || readTokenFile().refresh_token || "";
}

function calendarConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && refreshToken());
}

/**
 * Return a valid access token, minting a new one from the refresh token when
 * the cached one is missing or within a minute of expiry. Pass force=true to
 * discard the cache (used once after a 401, in case the token was revoked and
 * re-granted or the cache is stale).
 */
async function accessToken(force = false) {
  const cached = readTokenFile();
  const skewMs = 60 * 1000;
  if (!force && cached.access_token && (cached.expires_at ?? 0) - skewMs > Date.now()) {
    return cached.access_token;
  }
  const rt = refreshToken();
  if (!rt) throw new Error("No Google refresh token. Run `node scripts/google-auth.mjs` first.");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: rt,
      grant_type: "refresh_token",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Google token refresh failed (${res.status}): ${json.error_description ?? json.error ?? ""}. If the grant was revoked, re-run \`node scripts/google-auth.mjs\`.`,
    );
  }
  // Cache alongside the refresh token so repeated script calls in one
  // conversation do not re-mint. GOOGLE_REFRESH_TOKEN-only deployments still
  // benefit: the file then holds just the short-lived access token cache.
  writeTokenFile({
    ...cached,
    access_token: json.access_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

// ─── HTTP with retry (429/5xx backoff, one forced re-auth on 401) ───────────
async function gcal(pathname, method = "GET", body = undefined) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.");
  }
  let reauthed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(reauthed && attempt > 0);
    const res = await fetch(`${API}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !reauthed) {
      reauthed = true;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(2 ** attempt, 8) * 1000;
      await sleep(waitMs);
      continue;
    }
    if (res.status === 204) return {};
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.error?.message ?? "";
      throw new Error(`Google Calendar ${method} ${pathname} -> ${res.status}: ${msg}`);
    }
    return json;
  }
}

// ─── calendar id resolution ──────────────────────────────────────────────────
function readCalendarCache() {
  try {
    return JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf8"));
  } catch {
    return {};
  }
}

function calendarId() {
  return process.env.GOOGLE_CALENDAR_ID || readCalendarCache().calendarId || "primary";
}

// ─── pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Convert a CLI time string into a Google event time object.
 *   "2026-07-13"                -> { date } (all-day)
 *   "2026-07-13T18:00"          -> { dateTime: "...T18:00:00", timeZone } (local)
 *   "2026-07-13T18:00:00Z"      -> { dateTime } (explicit offset wins, no tz)
 */
function toEventTime(value, timeZone = TIMEZONE) {
  if (typeof value !== "string" || !value) throw new Error(`Invalid time: "${value}"`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/);
  if (!m) {
    throw new Error(
      `Invalid time "${value}". Use YYYY-MM-DD (all-day) or YYYY-MM-DDTHH:MM[:SS][Z|±hh:mm].`,
    );
  }
  const [, date, hh, mm, ss, offset] = m;
  const dateTime = `${date}T${hh}:${mm}${ss ?? ":00"}${offset ?? ""}`;
  // A trailing Z or ±hh:mm pins the instant; otherwise interpret in timeZone.
  return offset ? { dateTime } : { dateTime, timeZone };
}

/**
 * Parse a --reminders spec into a Google reminders object.
 *   "popup:30"            -> one popup 30 minutes before
 *   "popup:30,email:60"   -> multiple overrides
 *   "default"             -> the calendar's default reminders
 *   "none"                -> no reminders
 */
function parseReminders(spec) {
  if (!spec || spec === "default") return { useDefault: true };
  if (spec === "none") return { useDefault: false, overrides: [] };
  const overrides = spec.split(",").map((part) => {
    const [method, minutes] = part.trim().split(":");
    const mins = Number.parseInt(minutes, 10);
    if (!["popup", "email"].includes(method) || !Number.isFinite(mins) || mins < 0) {
      throw new Error(`Invalid reminder "${part}". Use e.g. "popup:30" or "popup:30,email:60".`);
    }
    return { method, minutes: mins };
  });
  return { useDefault: false, overrides };
}

/**
 * Build an event body from CLI args. For create, start/end/title are required
 * and reminders default to a popup 30 minutes before (the whole point of the
 * integration: session reminders on the phone without Telegram). For update
 * (partial=true) only the provided fields are included.
 */
function buildEventBody(args, { partial = false, timeZone = TIMEZONE } = {}) {
  const body = {};
  if (args.title !== undefined) body.summary = String(args.title);
  if (args.description !== undefined) body.description = String(args.description);
  if (args.location !== undefined) body.location = String(args.location);
  if (args.start !== undefined) body.start = toEventTime(args.start, timeZone);
  if (args.end !== undefined) body.end = toEventTime(args.end, timeZone);
  if (args.recurrence !== undefined) {
    const rule = String(args.recurrence);
    if (!/^RRULE:/i.test(rule)) {
      throw new Error(
        `Invalid --recurrence "${rule}". Expected an RRULE like "RRULE:FREQ=WEEKLY;BYDAY=MO,TH".`,
      );
    }
    body.recurrence = [rule];
  }
  if (args.reminders !== undefined) body.reminders = parseReminders(args.reminders);

  if (!partial) {
    if (!body.summary) throw new Error("--title is required.");
    if (!body.start || !body.end) throw new Error("--start and --end are required.");
    if ("date" in body.start !== "date" in body.end) {
      throw new Error("--start and --end must both be all-day dates or both be times.");
    }
    if (!body.reminders) body.reminders = parseReminders("popup:30");
  }
  return body;
}

/**
 * Resolve a --from/--to pair into an RFC3339 window. --from defaults to today
 * is not assumed (the caller passes the date from the Telegram header); --to
 * defaults to 7 days after --from. Bare dates span from local midnight.
 */
function resolveWindow(from, to, timeZone = TIMEZONE) {
  if (!from) throw new Error("--from is required (YYYY-MM-DD or an ISO datetime).");
  const start = toEventTime(String(from), timeZone);
  const timeMin = start.date ? `${start.date}T00:00:00` : start.dateTime;
  let timeMax;
  if (to) {
    const end = toEventTime(String(to), timeZone);
    // A bare --to date means "through the end of that day".
    timeMax = end.date ? `${end.date}T23:59:59` : end.dateTime;
  } else {
    const base = new Date(`${timeMin.slice(0, 10)}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + 7);
    timeMax = `${base.toISOString().slice(0, 10)}T00:00:00`;
  }
  return { timeMin, timeMax };
}

/** One compact, phone-log-friendly line per event, id included for update/delete. */
function formatEventLine(ev) {
  const start = ev.start?.dateTime ?? ev.start?.date ?? "?";
  const end = ev.end?.dateTime ?? ev.end?.date ?? "?";
  const when = ev.start?.date
    ? `${start} (all day)`
    : `${start.slice(0, 16).replace("T", " ")} -> ${end.slice(11, 16)}`;
  const recurring = ev.recurrence || ev.recurringEventId ? " [recurring]" : "";
  return `${when}  ${ev.summary ?? "(untitled)"}${recurring}  [id: ${ev.id}]`;
}

// ─── commands ────────────────────────────────────────────────────────────────
async function cmdStatus() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.log("Not configured: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing.");
    return;
  }
  if (!refreshToken()) {
    console.log("Not authorised: no refresh token. Run `node scripts/google-auth.mjs`.");
    return;
  }
  const id = calendarId();
  const cal = await gcal(`/calendars/${encodeURIComponent(id)}`);
  console.log(`Configured. Calendar: "${cal.summary}" (${id}), timezone ${cal.timeZone}.`);
}

async function cmdList(args) {
  const { timeMin, timeMax } = resolveWindow(args.from, args.to);
  const params = new URLSearchParams({
    timeMin: new Date(`${timeMin}${/Z|[+-]\d{2}:\d{2}$/.test(timeMin) ? "" : "Z"}`).toISOString(),
    timeMax: new Date(`${timeMax}${/Z|[+-]\d{2}:\d{2}$/.test(timeMax) ? "" : "Z"}`).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(args.limit ?? 50),
  });
  const json = await gcal(`/calendars/${encodeURIComponent(calendarId())}/events?${params}`);
  const events = json.items ?? [];
  if (events.length === 0) {
    console.log(`No events between ${timeMin} and ${timeMax}.`);
    return;
  }
  for (const ev of events) console.log(formatEventLine(ev));
}

async function cmdCreate(args) {
  const body = buildEventBody(args);
  const ev = await gcal(`/calendars/${encodeURIComponent(calendarId())}/events`, "POST", body);
  console.log(`Created: ${formatEventLine(ev)}`);
  if (ev.htmlLink) console.log(`Link: ${ev.htmlLink}`);
}

async function cmdUpdate(args) {
  if (!args.id) throw new Error("--id is required.");
  const body = buildEventBody(args, { partial: true });
  if (Object.keys(body).length === 0)
    throw new Error("Nothing to update: pass at least one field.");
  const ev = await gcal(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(args.id)}`,
    "PATCH",
    body,
  );
  console.log(`Updated: ${formatEventLine(ev)}`);
}

async function cmdDelete(args) {
  if (!args.id) throw new Error("--id is required.");
  await gcal(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(args.id)}`,
    "DELETE",
  );
  console.log(`Deleted event ${args.id}.`);
}

async function cmdListCalendars() {
  const json = await gcal("/users/me/calendarList");
  for (const cal of json.items ?? []) {
    const marks = [cal.primary ? "primary" : "", cal.id === calendarId() ? "in use" : ""]
      .filter(Boolean)
      .join(", ");
    console.log(`${cal.summary}  [id: ${cal.id}]${marks ? `  (${marks})` : ""}`);
  }
}

/**
 * Point the helper at a calendar by name, creating it when --create is passed
 * and no calendar with that name exists. The chosen id is cached in
 * data/google-calendar.json (same trust tier as notion-ids.json) so every
 * later command targets it without the user setting GOOGLE_CALENDAR_ID.
 */
async function cmdUseCalendar(args) {
  const name = args.name && args.name !== true ? String(args.name) : "";
  if (!name) throw new Error('--name is required, e.g. --name "Oak Training".');
  const json = await gcal("/users/me/calendarList");
  let cal = (json.items ?? []).find((c) => c.summary === name);
  if (!cal && args.create) {
    cal = await gcal("/calendars", "POST", { summary: name, timeZone: TIMEZONE });
    console.log(`Created calendar "${name}".`);
  }
  if (!cal) {
    throw new Error(`No calendar named "${name}". Pass --create to create it.`);
  }
  fs.mkdirSync(path.dirname(CALENDAR_FILE), { recursive: true });
  const tmp = `${CALENDAR_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ calendarId: cal.id, name }, null, 2));
  fs.renameSync(tmp, CALENDAR_FILE);
  console.log(`Using calendar "${name}" (${cal.id}). Cached to data/google-calendar.json.`);
}

const COMMANDS = {
  status: cmdStatus,
  list: cmdList,
  create: cmdCreate,
  update: cmdUpdate,
  delete: cmdDelete,
  "list-calendars": cmdListCalendars,
  "use-calendar": cmdUseCalendar,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`Unknown command "${command}". Use one of: ${Object.keys(COMMANDS).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (command !== "status" && !calendarConfigured()) {
    console.error(
      "Google Calendar is not configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET " +
        "and run `node scripts/google-auth.mjs` once (see docs/google-calendar-architecture.md).",
    );
    process.exitCode = 1;
    return;
  }
  await fn(parseArgs(rest));
}

// Run only when invoked directly, so the pure helpers can be unit-tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

export { parseArgs, toEventTime, parseReminders, buildEventBody, resolveWindow, formatEventLine };
