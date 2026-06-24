import { config } from "../config.js";

/**
 * Notion access.
 *
 * The agent talks to Notion exclusively through the REST API, driven by the
 * bundled `scripts/notion.mjs` and `scripts/setup-workspace.mjs` helpers (run via
 * Bash). There is no Notion MCP server: the REST API does everything the MCP
 * server did and more (rich blocks, tables, columns, database rows, icons), so
 * defaulting to it keeps pages well structured and avoids a second code path.
 *
 * Both helpers read the integration token from NOTION_TOKEN. The integration
 * must be shared with the pages and databases you want the agent to read and
 * write. When no token is configured the bot still runs, just without Notion.
 */
export function notionConfigured(): boolean {
  return Boolean(config.notionToken);
}
