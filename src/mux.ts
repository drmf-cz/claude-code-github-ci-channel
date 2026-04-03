/**
 * Mux server — multi-session entry point.
 *
 * Runs as a single persistent process (not spawned by Claude Code):
 *   bun run src/mux.ts [--config path/to/config.yaml]
 *
 * Exposes two HTTP endpoints:
 *   :9443  — GitHub webhook receiver (internet-facing via tunnel)
 *   :9444  — MCP over Streamable HTTP (localhost only, one URL for all sessions)
 *
 * Each Claude Code session connects to http://localhost:9444/mcp via .mcp.json
 * (no subprocess spawned). Sessions register their repo+branch filter by calling
 * the set_filter MCP tool once on startup. Events are routed only to sessions
 * whose filter matches the webhook event's repo and branch.
 *
 * Environment variables (can be placed in a .env file — Bun loads it automatically):
 *   GITHUB_WEBHOOK_SECRET  required  HMAC secret for webhook verification
 *   GITHUB_TOKEN           required  PAT for log fetching and PR status checks
 *   WEBHOOK_PORT           optional  Webhook receiver port (default: 9443)
 *   MCP_PORT               optional  MCP HTTP port (default: 9444)
 */

import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import type { NotifyFn, RoutingKey } from "./server.js";
import { createMcpServer, sendChannelNotification, startWebhookServer } from "./server.js";
import type { CINotification } from "./types.js";

const log = (...args: unknown[]) => console.error("[github-ci:mux]", ...args);

// ── Session registry ──────────────────────────────────────────────────────────

interface SessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  /** Repo filter ("owner/repo"). null = receive events for all repos. */
  repo: string | null;
  /** Branch filter. null = receive events for all branches of the matched repo. */
  branch: string | null;
  /** Updated on every incoming request — used to detect idle/abandoned sessions. */
  lastActivityAt: number;
}

const sessions = new Map<string, SessionEntry>();

// ── Session TTL ───────────────────────────────────────────────────────────────
// Streamable HTTP has no persistent connection, so onsessionclosed is not
// reliably called when Claude Code exits or context-resets. Without this cleanup
// sessions accumulate indefinitely and receive routing noise.
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes

setInterval(
  () => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivityAt > SESSION_IDLE_TTL_MS) {
        sessions.delete(id);
        log(`Session ${id.slice(0, 8)} idle >30 min — removed (total: ${sessions.size})`);
      }
    }
  },
  5 * 60 * 1000,
).unref(); // unref so the interval doesn't keep the process alive

// ── Routing ───────────────────────────────────────────────────────────────────

function matchesSession(session: SessionEntry, routing: RoutingKey): boolean {
  if (session.repo === null) return true; // wildcard — receives everything
  if (session.repo !== routing.repo) return false;
  if (routing.branch === null) return true; // event has no branch — broadcast to repo
  if (session.branch === null) return true; // session watches all branches for repo
  return session.branch === routing.branch;
}

const routeToSessions: NotifyFn = async (
  notification: CINotification,
  routing: RoutingKey,
): Promise<void> => {
  let sent = 0;
  for (const session of sessions.values()) {
    if (!matchesSession(session, routing)) continue;
    try {
      await sendChannelNotification(session.server, notification);
      sent++;
    } catch (err) {
      log("Failed to push notification to session:", err);
    }
  }
  if (sent === 0) {
    const registered = [...sessions.values()].map((s) => `${s.repo ?? "*"}@${s.branch ?? "*"}`);
    log(
      `No session matched ${routing.repo}@${routing.branch ?? "*"} — notification dropped.`,
      `Registered filters: [${registered.join(", ") || "none — call set_filter first"}]`,
    );
  } else {
    log(`Pushed to ${sent} session(s): ${routing.repo}@${routing.branch ?? "*"}`);
  }
};

// ── Session factory ───────────────────────────────────────────────────────────

function createSession(): {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
} {
  const server = createMcpServer();

  // set_filter is session-scoped: the closure captures the session entry once
  // onsessioninitialized fires and populates it.
  let entry: SessionEntry | undefined;

  server.tool(
    "set_filter",
    [
      "Register this Claude Code session's repo and branch so it receives only",
      "matching GitHub CI/PR notifications. Call once on session startup.",
      "Get the values with: git remote get-url origin  and  git branch --show-current",
    ].join(" "),
    {
      repo: z
        .string()
        .nullable()
        .describe(
          'Full repository name ("owner/repo") parsed from git remote URL, or null for all repos',
        ),
      branch: z
        .string()
        .nullable()
        .describe("Current branch from git, or null for all branches in the repo"),
    },
    async ({ repo, branch }) => {
      if (entry) {
        entry.repo = repo;
        entry.branch = branch;
      }
      log(`Filter set → repo=${repo ?? "*"} branch=${branch ?? "*"}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `Filter registered: ${repo ?? "*"}@${branch ?? "*"}. This session will only receive events matching that repo and branch.`,
          },
        ],
      };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      entry = { server, transport, repo: null, branch: null, lastActivityAt: Date.now() };
      sessions.set(sessionId, entry);
      log(`Session connected: ${sessionId.slice(0, 8)} (total: ${sessions.size})`);
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
      log(`Session disconnected: ${sessionId.slice(0, 8)} (total: ${sessions.size})`);
    },
  });

  return { server, transport };
}

// ── MCP HTTP server ───────────────────────────────────────────────────────────

const MCP_PORT = Number(process.env.MCP_PORT ?? 9444);

Bun.serve({
  port: MCP_PORT,
  hostname: "127.0.0.1", // local-only — not exposed to the internet
  // MCP Streamable HTTP keeps a persistent SSE connection open between events.
  // Bun's default 10-second idle timeout kills that connection silently —
  // onsessionclosed is NOT called, the session stays registered, but
  // subsequent notifications are dropped. Disable the timeout entirely.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname !== "/mcp") {
      return new Response(JSON.stringify({ status: "ok", server: "github-ci-mux" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const sessionId = req.headers.get("mcp-session-id");

    // Existing session — route to its transport
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return new Response("Session not found", { status: 404 });
      }
      session.lastActivityAt = Date.now();
      return session.transport.handleRequest(req);
    }

    // New session — only POST (initialize) is valid without a session ID
    if (req.method !== "POST") {
      return new Response("Bad Request — send POST to initialize a new session", {
        status: 400,
      });
    }

    const { server, transport } = createSession();
    await server.connect(transport);
    return transport.handleRequest(req);
  },
});

log(`MCP HTTP server listening on http://127.0.0.1:${MCP_PORT}/mcp`);

// ── Webhook server ────────────────────────────────────────────────────────────

const { configPath, authors } = (() => {
  const configIdx = process.argv.indexOf("--config");
  const cliAuthors: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--author" && process.argv[i + 1]) {
      cliAuthors.push(process.argv[i + 1] ?? "");
    }
  }
  return {
    configPath: configIdx !== -1 ? (process.argv[configIdx + 1] ?? null) : null,
    authors: cliAuthors,
  };
})();

let config = DEFAULT_CONFIG;
if (configPath) {
  try {
    config = loadConfig(configPath);
    log(`Loaded config from ${configPath}`);
  } catch (err) {
    log(`ERROR: Failed to load config: ${err}`);
    process.exit(1);
  }
}

if (authors.length > 0) {
  config.webhooks.allowed_authors = [...new Set([...config.webhooks.allowed_authors, ...authors])];
}

if (config.webhooks.allowed_authors.length === 0) {
  log(
    "ERROR: webhooks.allowed_authors is required and must not be empty.",
    "\nAdd your GitHub username (and optionally your email for co-author matching via bots like Devin).",
    "\nExample config.yaml:",
    "\n  webhooks:",
    "\n    allowed_authors:",
    "\n      - YourGitHubUsername",
    "\n      - you@company.com  # for Co-Authored-By matching",
    "\nOr pass directly: claude-beacon-mux --author YourGitHubUsername",
  );
  process.exit(1);
}

try {
  const webhookServer = startWebhookServer(routeToSessions, config);
  log(`Webhook server listening on http://localhost:${webhookServer.port}`);
} catch (err: unknown) {
  const isAddrInUse =
    typeof err === "object" && err !== null && "code" in err && err.code === "EADDRINUSE";
  if (isAddrInUse) {
    log(`ERROR: Port ${config.server.port} is already in use. Only one mux may run at a time.`);
  } else {
    log("ERROR: Failed to start webhook server:", err);
  }
  process.exit(1);
}

log("Mux ready — waiting for Claude Code sessions and webhook events.");
