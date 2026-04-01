import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, startWebhookServer } from "./server.js";

const log = (...args: unknown[]) => console.error("[github-ci]", ...args);

const mcp = createMcpServer();
const server = startWebhookServer(mcp);

log(`Webhook server listening on http://localhost:${server.port}`);

const transport = new StdioServerTransport();
await mcp.connect(transport);
log("MCP channel connected to Claude Code");
