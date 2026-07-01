import fs from "node:fs";
import path from "node:path";

/**
 * Write JSON to disk atomically: serialise to a sibling temp file, then rename
 * over the target. rename(2) is atomic on the same filesystem, so a crash mid-write
 * can never leave a half-written file that the next read parses as empty (and so
 * silently loses sessions, the schedule, or the Notion id cache). Mirrors the
 * pattern used by the Notion helper scripts.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
  fs.renameSync(tmp, filePath);
}
