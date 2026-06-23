import { type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";

/**
 * MCP servers wired up per query.
 *
 * Notion: uses the official self-hostable @notionhq/notion-mcp-server over stdio,
 * authenticated with an internal integration token. The integration must be shared
 * with the pages and databases you want the agent to read and write. If no token is
 * configured we return no servers, so the bot still runs (just without Notion).
 */
export function getMcpServers(): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  if (config.notionToken) {
    servers.notion = {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: {
        // The Notion MCP server reads its token from this env var.
        NOTION_TOKEN: config.notionToken,
      },
    };
  }

  return servers;
}

export function notionConfigured(): boolean {
  return Boolean(config.notionToken);
}
