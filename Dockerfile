# ── Build stage ────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Prune dev dependencies for the runtime image
RUN npm prune --production

# Strip the musl variant of the SDK's native binary. node:22-slim is Debian glibc,
# but npm installs both linux-x64 and linux-x64-musl optional deps, and the SDK's
# runtime discovery tries musl FIRST. Leaving the musl dir present causes the SDK
# to spawn a musl binary on glibc, which fails with ENOENT from the dynamic linker.
RUN rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app

# git and ca-certificates are needed by the SDK and for any npx fetches.
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends ca-certificates git && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy built application (no dev deps, no source)
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Copy project files. CLAUDE.md and the plugin are made read-only so the agent
# cannot rewrite its own persona or skills at runtime.
COPY CLAUDE.md ./
COPY coach-plugin/ ./coach-plugin/
RUN chmod 444 CLAUDE.md && chmod -R 555 coach-plugin/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Pre-install the Notion MCP server so the SDK does not download it at runtime.
RUN npm install -g @notionhq/notion-mcp-server@1.8.1

# /data is the mountpoint for the persistent volume (sessions + schedule).
RUN chown -R node:node /app/dist /app/node_modules /app/package.json /app/entrypoint.sh && \
    mkdir -p /home/node/.claude && chown -R node:node /home/node && \
    mkdir -p /data && chown node:node /data

USER node

EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]
