import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, startWebhookServer } from "./server.js";

const log = (...args: unknown[]) => console.error("[github-ci]", ...args);

const mcp = createMcpServer();

try {
  const webhookServer = startWebhookServer(mcp);
  log(`Webhook server listening on http://localhost:${webhookServer.port}`);
} catch (err: unknown) {
  const isAddrInUse =
    typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE";
  if (isAddrInUse) {
    log(
      `ERROR: Port ${process.env.WEBHOOK_PORT ?? "9443"} is already in use.`,
      "Kill the existing process (lsof -i :9443) and restart Claude Code.",
    );
  } else {
    log("ERROR: Failed to start webhook server:", err);
  }
  process.exit(1);
}

const transport = new StdioServerTransport();
await mcp.connect(transport);
log("MCP channel connected to Claude Code");
