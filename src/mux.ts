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
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import type { NotifyFn, RoutingKey } from "./server.js";
import { createMcpServer, sendChannelNotification, startWebhookServer } from "./server.js";
import type { CINotification } from "./types.js";

const log = (...args: unknown[]) => console.error("[github-ci:mux]", ...args);

// ── Claim file helpers ─────────────────────────────────────────────────────────
// Written to ~/.claude/beacon-active-claim so a Claude Code Stop hook can read
// the current claim key and POST /release-claim to free it without an MCP call.

const CLAIM_FILE = join(homedir(), ".claude", "beacon-active-claim");

function writeClaimFile(claimKey: string): void {
  try {
    writeFileSync(CLAIM_FILE, claimKey, "utf8");
  } catch {
    // Non-fatal — Stop hook will fall back to TTL expiry
  }
}

function deleteClaimFile(): void {
  try {
    rmSync(CLAIM_FILE, { force: true });
  } catch {
    // Non-fatal
  }
}

// ── Notification event store ───────────────────────────────────────────────────
// The MCP Streamable HTTP transport sends notifications via the standalone GET
// SSE stream. If that connection is temporarily down (Claude Code reconnecting),
// the SDK silently drops the event — no exception, so the caller never knows.
// Providing an EventStore causes the SDK to buffer missed events and replay them
// the next time the client opens a GET /mcp request with Last-Event-ID.

class NotificationEventStore implements EventStore {
  private events = new Map<string, { streamId: string; message: unknown }>();

  async storeEvent(streamId: string, message: unknown): Promise<string> {
    const id = `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.events.set(id, { streamId, message });
    return id;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (id: string, msg: unknown) => Promise<void> },
  ): Promise<string> {
    if (!lastEventId || !this.events.has(lastEventId)) return "";
    const streamId = lastEventId.split("_")[0] ?? "";
    let found = false;
    for (const [id, { streamId: sid, message }] of [...this.events.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      if (sid !== streamId) continue;
      if (id === lastEventId) {
        found = true;
        continue;
      }
      if (found) await send(id, message);
    }
    return streamId;
  }
}

// ── Session registry ──────────────────────────────────────────────────────────

interface SessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  /** Repo filter ("owner/repo"). null = receive events for all repos. */
  repo: string | null;
  /** Branch filter. null = receive events for all branches of the matched repo. */
  branch: string | null;
  /** Human-readable label, e.g. "fix/my-branch". Used in conflict messages. */
  label: string | null;
  /** Absolute path of this session's working directory (git rev-parse --show-toplevel). */
  worktree_path: string | null;
  /** Updated on every incoming request — used to detect idle/abandoned sessions. */
  lastActivityAt: number;
}

// ── Work-context claims ───────────────────────────────────────────────────────
// Key = "{repo}:{branch}" or "{repo}:*" for broadcast events.
// Only one session may hold a claim at a time; others must stop.

interface WorkClaim {
  sessionId: string;
  label: string | null;
  expiresAt: number;
}

const workClaims = new Map<string, WorkClaim>();

setInterval(() => {
  const now = Date.now();
  for (const [k, c] of workClaims) {
    if (now > c.expiresAt) {
      workClaims.delete(k);
      deleteClaimFile();
      log(`Claim expired: ${k}`);
      // Notify the owning session that its claim has lapsed
      const ownerSession = sessions.get(c.sessionId);
      if (ownerSession) {
        sendStatusLine(ownerSession.server, buildStatusText(ownerSession)).catch(() => {});
      }
    }
  }
}, 60_000).unref();

function claimKeyFor(routing: RoutingKey): string {
  return routing.branch ? `${routing.repo}:${routing.branch}` : `${routing.repo}:*`;
}

const sessions = new Map<string, SessionEntry>();

// ── Pre-registration notification queue ───────────────────────────────────────
// When a webhook event arrives before any Claude Code session has registered,
// the notification would normally be dropped. Instead we buffer it here and
// flush it the moment a session calls set_filter.
//
// Why this happens: the mux may restart (clearing sessions) while Claude Code
// is already running. Claude Code's existing session ID returns 404, but it
// does not automatically re-initialize until it next calls a tool. The queued
// notifications bridge that gap.

interface PendingNotification {
  notification: CINotification;
  routing: RoutingKey;
  receivedAt: number;
}

/** Events queued while no session was registered. Keyed by repo ("owner/repo"). */
const pendingByRepo = new Map<string, PendingNotification[]>();

/** How long a queued notification stays relevant before being discarded. */
const PENDING_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Maximum distinct repo keys held in the pending queue (DoS guard). */
const MAX_PENDING_REPOS = 100;
/** Maximum queued notifications per repo (DoS guard). */
const MAX_PENDING_PER_REPO = 50;

function enqueuePending(routing: RoutingKey, notification: CINotification): void {
  const key = routing.repo ?? "*";
  const now = Date.now();

  // Evict oldest repo entry if we hit the global key cap.
  if (!pendingByRepo.has(key) && pendingByRepo.size >= MAX_PENDING_REPOS) {
    const oldest = pendingByRepo.keys().next().value;
    if (oldest !== undefined) pendingByRepo.delete(oldest);
  }

  const existing = (pendingByRepo.get(key) ?? []).filter(
    (n) => now - n.receivedAt < PENDING_TTL_MS,
  );

  if (existing.length >= MAX_PENDING_PER_REPO) {
    existing.shift(); // drop oldest to make room
  }

  existing.push({ notification, routing, receivedAt: now });
  pendingByRepo.set(key, existing);
  log(
    `Queued for replay (no session): ${routing.repo}@${routing.branch ?? "*"} — queue depth: ${existing.length}`,
  );
}

async function flushPendingToSession(repo: string | null, session: SessionEntry): Promise<void> {
  const keys = repo !== null ? [repo] : [...pendingByRepo.keys()];
  const now = Date.now();
  for (const key of keys) {
    const pending = pendingByRepo.get(key);
    if (!pending || pending.length === 0) continue;
    const fresh = pending.filter((n) => now - n.receivedAt < PENDING_TTL_MS);
    if (fresh.length === 0) {
      pendingByRepo.delete(key);
      continue;
    }
    log(`Flushing ${fresh.length} queued notification(s) for ${key} to newly registered session`);
    let anyDelivered = false;
    for (const { notification, routing } of fresh) {
      const claimKey = claimKeyFor(routing);
      const enriched = enrichNotification(notification, claimKey, "normal");
      try {
        await sendChannelNotification(session.server, enriched);
        anyDelivered = true;
      } catch (err) {
        log(`Failed to flush pending notification for ${key}:`, err);
      }
    }
    if (anyDelivered) {
      pendingByRepo.delete(key);
    } else {
      log(`All flush attempts failed for ${key} — retaining queue for next session`);
    }
  }
}

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
        // Clean up any stale claims owned by this session
        for (const [k, c] of workClaims) {
          if (c.sessionId === id) {
            workClaims.delete(k);
            log(`Stale claim cleared: ${k} (session was idle)`);
          }
        }
      }
    }
  },
  5 * 60 * 1000,
).unref(); // unref so the interval doesn't keep the process alive

// ── Routing ───────────────────────────────────────────────────────────────────

/**
 * Three-tier session selection:
 *
 * Tier 1+2 — Sessions that match by repo AND (exact branch OR wildcard branch).
 *   These are the ideal handlers: already in the right worktree or opted into all branches.
 *   Within this tier, exact-branch sessions are sorted first to give them a head-start
 *   in the claim race.
 *
 * Tier 3 (catch-all) — Activated only when Tier 1+2 yields nothing.
 *   Any session registered for the same repo (possibly on a different branch).
 *   These must create a worktree to handle the work without polluting their current branch.
 */
function selectRecipients(
  sessionMap: Map<string, SessionEntry>,
  routing: RoutingKey,
): { recipients: SessionEntry[]; mode: "normal" | "catchall" } {
  const forRepo = (s: SessionEntry) => s.repo === null || s.repo === routing.repo;

  // Tier 1+2: exact branch match OR wildcard branch, for this repo
  const primary = [...sessionMap.values()].filter(
    (s) =>
      forRepo(s) && (s.branch === null || routing.branch === null || s.branch === routing.branch),
  );

  if (primary.length > 0) {
    // Sort: exact-branch sessions first (give them head-start in claim race)
    const sorted = [
      ...primary.filter((s) => routing.branch !== null && s.branch === routing.branch),
      ...primary.filter((s) => !(routing.branch !== null && s.branch === routing.branch)),
    ];
    return { recipients: sorted, mode: "normal" };
  }

  // Tier 3: no matching session → catch-all, any session for this repo
  const catchall = [...sessionMap.values()].filter(forRepo);
  return { recipients: catchall, mode: "catchall" };
}

/**
 * Enrich a notification with claim instructions before delivery.
 *
 * Modes:
 *   "owned"   — pre-routing sent to owner; no claim instruction needed
 *   "normal"  — claim instruction + worktree decision tree
 *   "catchall"— "⚠️ CATCH-ALL" header; all recipients must create a worktree
 */
function enrichNotification(
  n: CINotification,
  claimKey: string,
  mode: "owned" | "normal" | "catchall",
): CINotification {
  const meta = { ...n.meta, claim_key: claimKey };
  if (mode === "owned") return { meta, summary: n.summary };

  const branch = n.meta.branch ?? n.meta.head_branch ?? null;
  const branchSlug = branch?.replace(/[^a-z0-9]/gi, "-") ?? "fix";

  const catchallHeader =
    mode === "catchall"
      ? [
          "⚠️  CATCH-ALL DELIVERY: no session is currently in the worktree for this branch.",
          "One of you must volunteer by claiming it and creating a worktree.",
          "",
        ]
      : [];

  const worktreeBlock = branch
    ? [
        `IF claim returns "ok":`,
        `  a) Your current branch IS "${branch}":`,
        `     → Fix here in your current directory`,
        `  b) Your current branch IS NOT "${branch}":`,
        `     → git worktree add /tmp/${branchSlug}-fix ${branchSlug}`,
        `     → Fix in that worktree, commit, push`,
        `     → Call release_claim("${claimKey}") when done`,
        `     → git worktree remove /tmp/${branchSlug}-fix`,
      ]
    : [
        `IF claim returns "ok": fix in your current directory.`,
        `Call release_claim("${claimKey}") when done.`,
      ];

  const claimBlock = [
    "",
    "─────────────────────────────────────────",
    ...catchallHeader,
    `BEFORE ACTING: call claim_notification("${claimKey}")`,
    '  "ok"           → you have the lock, continue',
    '  "already_owned"→ you already hold it (TTL extended); continue if still working',
    '  "conflict:X"   → session X claimed it, STOP immediately',
    '  "expired"      → STOP',
    "",
    ...worktreeBlock,
    "─────────────────────────────────────────",
  ].join("\n");

  return { meta, summary: n.summary + claimBlock };
}

const routeToSessions: NotifyFn = async (
  notification: CINotification,
  routing: RoutingKey,
): Promise<void> => {
  const claimKey = claimKeyFor(routing);
  const existing = workClaims.get(claimKey);

  // Pre-routing: active claim → send only to the owner (no claim instruction needed)
  if (existing && Date.now() <= existing.expiresAt) {
    const ownerSession = sessions.get(existing.sessionId);
    if (ownerSession) {
      const enriched = enrichNotification(notification, claimKey, "owned");
      try {
        await sendChannelNotification(ownerSession.server, enriched);
        log(
          `Routed to claim owner ${existing.label ?? existing.sessionId.slice(0, 8)}: ${claimKey}`,
        );
      } catch (err) {
        log("Failed to push to claim owner — clearing stale claim, re-broadcasting:", err);
        workClaims.delete(claimKey);
        // Fall through to re-broadcast below
      }
      return;
    }
    // Owner session is gone — clear stale claim and re-broadcast
    log(`Claim owner for ${claimKey} is gone — clearing claim, re-broadcasting`);
    workClaims.delete(claimKey);
  }

  // No active claim — select recipients via three-tier logic
  const { recipients, mode } = selectRecipients(sessions, routing);
  if (recipients.length === 0) {
    const registered = [...sessions.values()].map((s) => `${s.repo ?? "*"}@${s.branch ?? "*"}`);
    log(
      `No session found for ${routing.repo} — queuing for replay.`,
      `Registered: [${registered.join(", ") || "none"}]`,
    );
    enqueuePending(routing, notification);
    return;
  }

  if (mode === "catchall") {
    log(
      `⚠️  No session on ${routing.branch ?? "*"} — using catch-all (${recipients.length} sessions)`,
    );
  }

  const enriched = enrichNotification(notification, claimKey, mode);
  let sent = 0;
  for (const session of recipients) {
    try {
      await sendChannelNotification(session.server, enriched);
      sent++;
    } catch (err) {
      log("Failed to push notification to session:", err);
    }
  }
  if (sent > 0) {
    log(`Pushed to ${sent} session(s): ${routing.repo}@${routing.branch ?? "*"}`);
  }
};

// ── Status line ───────────────────────────────────────────────────────────────

/**
 * Send a `notifications/claude/statusLine` notification to update the
 * persistent status indicator in the Claude Code UI for this session.
 * Errors are swallowed — the status line is best-effort.
 */
async function sendStatusLine(server: McpServer, text: string): Promise<void> {
  try {
    await server.server.notification({
      method: "notifications/claude/statusLine",
      params: { text },
    });
  } catch {
    // Best-effort — some Claude Code versions may not support statusLine
  }
}

function buildStatusText(entry: SessionEntry, claimKey?: string, claimExpiresAt?: number): string {
  const reg = entry.branch
    ? `claude-beacon ✓ registered · ${entry.branch}`
    : `claude-beacon ✓ registered`;
  if (!claimKey || !claimExpiresAt) return reg;
  const minsLeft = Math.max(1, Math.ceil((claimExpiresAt - Date.now()) / 60_000));
  return `${reg} | claim: ${claimKey} (${minsLeft}m left)`;
}

// ── Session factory ───────────────────────────────────────────────────────────

function createSession(): {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
} {
  const server = createMcpServer();

  // The startup resource is already registered by createMcpServer() for single-session mode.
  // In mux mode the same resource is inherited — no additional registration needed here.

  // set_filter, claim_notification, and release_claim are session-scoped: the closure
  // captures the session entry once onsessioninitialized fires and populates it.
  let entry: SessionEntry | undefined;
  let sessionId = "";

  server.tool(
    "set_filter",
    [
      "Register this Claude Code session's repo and branch so it receives only",
      "matching GitHub CI/PR notifications. Call once on session startup, and again",
      "after leaving a worktree (to re-register with your original branch).",
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
      label: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Human-readable session name, e.g. 'fix/my-branch' or 'worktree:/tmp/beacon-fix'. Shown in conflict messages.",
        ),
      worktree_path: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Absolute path of this session's working directory (git rev-parse --show-toplevel). Used for routing diagnostics.",
        ),
    },
    async ({ repo, branch, label, worktree_path }) => {
      if (entry) {
        entry.repo = repo;
        entry.branch = branch;
        entry.label = label ? label.replace(/[^\x20-\x7E]/g, "").slice(0, 80) : null;
        entry.worktree_path = worktree_path ?? null;
      }
      if (branch === null) {
        log(`⚠️  Session registered with branch=null — receives all events for repo ${repo ?? "*"}`);
      }
      log(
        `Filter set → ${repo ?? "*"}@${branch ?? "*"} label=${label ?? "-"} path=${worktree_path ?? "-"}`,
      );
      // Flush any notifications that arrived before this session registered.
      // Guard: only flush if the requested repo is in allowed_repos (or allowed_repos
      // is empty, meaning all repos are permitted). This prevents a rogue localhost
      // process from claiming buffered notifications for a repo it shouldn't see.
      if (entry) {
        const repoAllowed =
          repo === null ||
          config.webhooks.allowed_repos.length === 0 ||
          config.webhooks.allowed_repos.includes(repo);
        if (repoAllowed) {
          await flushPendingToSession(repo, entry);
        } else {
          log(`set_filter: repo "${repo}" not in allowed_repos — pending flush skipped`);
        }
      }
      if (entry) {
        await sendStatusLine(server, buildStatusText(entry));
      }
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

  server.tool(
    "claim_notification",
    [
      "Claim exclusive ownership of work for a repo+branch before acting on a notification.",
      "Also call this proactively when entering a worktree to pre-emptively lock the branch.",
      "Returns:",
      "  'ok'            — you now own this branch, proceed",
      "  'already_owned' — you already own it (TTL extended); continue if still working",
      "  'conflict:<who>'— another session owns it, STOP immediately",
    ].join(" "),
    {
      claim_key: z
        .string()
        .describe(
          "'{repo}:{branch}' from notification meta.claim_key, or construct from git remote + current branch",
        ),
    },
    async ({ claim_key }) => {
      const existing = workClaims.get(claim_key);
      const ttl = config.server.claim_ttl_ms;
      const myLabel = entry?.label ?? sessionId.slice(0, 8);

      if (existing && Date.now() <= existing.expiresAt) {
        if (existing.sessionId === sessionId) {
          // Same session calling again (e.g. buffered re-delivery) — renew TTL
          existing.expiresAt = Date.now() + ttl;
          log(`Claim renewed: ${myLabel} still owns ${claim_key}`);
          if (entry)
            await sendStatusLine(server, buildStatusText(entry, claim_key, existing.expiresAt));
          return { content: [{ type: "text" as const, text: "already_owned" }] };
        }
        // Different session holds the lock
        const winner = existing.label ?? existing.sessionId.slice(0, 8);
        log(`Claim conflict: ${myLabel} lost to ${winner} on ${claim_key}`);
        return { content: [{ type: "text" as const, text: `conflict:${winner}` }] };
      }

      // No existing claim (or expired) — grant to this session
      const expiresAt = Date.now() + ttl;
      workClaims.set(claim_key, { sessionId, label: myLabel, expiresAt });
      writeClaimFile(claim_key);
      log(`Claim granted: ${myLabel} owns ${claim_key}`);
      if (entry) await sendStatusLine(server, buildStatusText(entry, claim_key, expiresAt));
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );

  server.tool(
    "release_claim",
    [
      "Release the branch claim when work is complete (after pushing and removing the worktree).",
      "Frees the branch immediately for future claim races rather than waiting for TTL expiry.",
      "Returns 'released' on success, 'not_owner' if this session does not hold the claim.",
    ].join(" "),
    {
      claim_key: z.string().describe("The same claim_key that was passed to claim_notification"),
    },
    async ({ claim_key }) => {
      const existing = workClaims.get(claim_key);
      if (!existing || existing.sessionId !== sessionId) {
        return { content: [{ type: "text" as const, text: "not_owner" }] };
      }
      workClaims.delete(claim_key);
      deleteClaimFile();
      log(`Claim released: ${entry?.label ?? sessionId.slice(0, 8)} released ${claim_key}`);
      if (entry) await sendStatusLine(server, buildStatusText(entry));
      return { content: [{ type: "text" as const, text: "released" }] };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      const id = randomUUID();
      sessionId = id;
      return id;
    },
    eventStore: new NotificationEventStore(),
    onsessioninitialized: (id) => {
      sessionId = id;
      entry = {
        server,
        transport,
        repo: null,
        branch: null,
        label: null,
        worktree_path: null,
        lastActivityAt: Date.now(),
      };
      sessions.set(id, entry);
      log(`Session connected: ${id.slice(0, 8)} (total: ${sessions.size})`);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      // Clear any claims this session held
      for (const [k, c] of workClaims) {
        if (c.sessionId === id) {
          workClaims.delete(k);
          log(`Claim cleared on disconnect: ${k}`);
        }
      }
      log(`Session disconnected: ${id.slice(0, 8)} (total: ${sessions.size})`);
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

    // POST /release-claim — lightweight HTTP release endpoint for the Stop hook.
    // The claim key acts as its own bearer token (UUID, unguessable without holding the claim).
    if (req.method === "POST" && url.pathname === "/release-claim") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      const claimKey =
        typeof (body as Record<string, unknown>)?.claim_key === "string"
          ? (body as Record<string, string>).claim_key
          : null;
      if (!claimKey || !workClaims.has(claimKey)) {
        return new Response("not_found", { status: 404 });
      }
      workClaims.delete(claimKey);
      log(`Claim released via HTTP: ${claimKey}`);
      return new Response("released", { status: 200 });
    }

    if (url.pathname !== "/mcp") {
      return new Response(JSON.stringify({ status: "ok", server: "claude-beacon-mux" }), {
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

const cliArgs = process.argv.slice(2);

// ── --help ────────────────────────────────────────────────────────────────────
if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
  process.stdout.write(`claude-beacon-mux — Persistent mux server for multi-session Claude Code

Usage:
  claude-beacon-mux --author <username> [options]

Required:
  --author <username|email>   GitHub username or email whose PRs trigger
                              actions. Repeat for multiple entries.

Options:
  --config <path>             Path to a YAML config file (see config.example.yaml)
  --help, -h                  Show this help message

Environment variables (put in .env or export in shell):
  GITHUB_WEBHOOK_SECRET       HMAC-SHA256 secret — must match GitHub webhook settings
  GITHUB_TOKEN                PAT for log fetching and PR status checks
                              Fine-grained: Actions:Read + Pull requests:Read
                              Classic: public_repo
  WEBHOOK_PORT                Webhook receiver port (default: 9443)
  MCP_PORT                    MCP HTTP port (default: 9444)
  REVIEW_DEBOUNCE_MS          Review event batching window ms (default: 30000)

Quick start (mux mode):
  1. Start the mux once (e.g. in a tmux pane):
       claude-beacon-mux --author YourGitHubUsername
  2. Register with Claude Code (run once):
       claude mcp add --transport http claude-beacon http://127.0.0.1:9444/mcp
  3. Start Claude Code normally:
       claude --dangerously-load-development-channels server:claude-beacon
  4. In the session, call set_filter to register:
       set_filter(repo="owner/repo", branch="main", label="main", worktree_path="/path/to/repo")

Routing: each session calls set_filter() to declare which repo+branch it watches.
Events are routed to matching sessions. Use claim_notification() before acting to
prevent two sessions from racing on the same task.

Full docs: https://github.com/drmf-cz/claude-beacon\n`);
  process.exit(0);
}

const { configPath, authors } = (() => {
  const configIdx = cliArgs.indexOf("--config");
  const cliAuthors: string[] = [];
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === "--author" && cliArgs[i + 1]) {
      cliAuthors.push(cliArgs[i + 1] ?? "");
    }
  }
  return {
    configPath: configIdx !== -1 ? (cliArgs[configIdx + 1] ?? null) : null,
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

// ── GitHub token probe ────────────────────────────────────────────────────────
// Validate GITHUB_TOKEN at startup so misconfiguration is visible immediately
// rather than surfacing as a silent 401 on the first push to main.
{
  log(`Working directory: ${process.cwd()} (Bun loads .env from here)`);
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    log(
      "WARNING: GITHUB_TOKEN is not set.",
      "Conflict/behind detection (checkPRsAfterPush) and log fetching will not work.",
      `Set GITHUB_TOKEN in ${process.cwd()}/.env and restart.`,
    );
  } else {
    const masked = `${token.slice(0, 8)}...`;
    log(`GITHUB_TOKEN found: ${masked}`);
    // Probe with GET /rate_limit — works with all token types (classic PAT, fine-grained,
    // OAuth, GitHub App). Fine-grained tokens return 401 on GET /user because that endpoint
    // requires user-level permissions they don't have.
    fetch("https://api.github.com/rate_limit", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
      .then((r) => {
        if (r.status === 401 || r.status === 403) {
          log(
            `WARNING: GITHUB_TOKEN validation failed (${r.status}) — token is expired, invalid, or not approved.`,
            `For fine-grained tokens: resource owner must be the org (not personal account),`,
            `required permissions: Pull requests (read), Actions (read).`,
            `Set a valid GITHUB_TOKEN in ${process.cwd()}/.env and restart.`,
          );
        } else {
          log(`GITHUB_TOKEN validated (status ${r.status})`);
        }
      })
      .catch(() => {
        // Network error — don't block startup, the server is responsible for retries.
      });
  }
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
