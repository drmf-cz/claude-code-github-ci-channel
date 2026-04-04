# Architecture and Design Decisions

Key design decisions in `claude-beacon` for contributors and evaluators.

---

## High-level architecture

```
GitHub ──webhook──► Bun HTTP (WEBHOOK_PORT)
                         │
                    HMAC-SHA256 verify
                         │
                    parse event → CINotification
                         │
                    MCP stdio / Streamable HTTP
                         │
                    Claude Code session
                         │
                    notifications/claude/channel
```

Two transports share a single Bun process: **HTTP** on `WEBHOOK_PORT` (default 9443) for GitHub webhooks, and **MCP (stdio or HTTP)** for Claude Code sessions.

---

## Decisions

**Bun over Node.js** — single-binary runtime with built-in HTTP, test runner, and TypeScript; no build step required. `Bun.CryptoHasher` and `timingSafeEqual` available natively.

**HMAC-SHA256 with `timingSafeEqual`** — GitHub signs every webhook payload. We verify with constant-time comparison to prevent timing oracle attacks. The secret is read from `process.env` on every call (not cached) so tests and env rotation work without restarts.

**LRU delivery ID cache (1 000 entries)** — `isDuplicateDelivery()` deduplicates retried webhooks via `X-GitHub-Delivery`. At 1 000 entries the oldest is evicted. Covers typical retry windows (a few minutes, far fewer than 1 000 events) with minimal memory.

**10 MB payload limit** — `isOversized()` rejects bodies before parsing. Generous enough for large matrix-job payloads (real-world max ~hundreds of KB), prevents memory exhaustion from malicious clients.

**Notifications as directives, not alerts** — `CINotification.content` is injected verbatim into Claude's session. Passive language ("CI failed") produced no action; imperative language with explicit Agent tool instructions produces autonomous response. Users who prefer review-before-action should customise the instruction templates.

**30-second PR review debounce** — batches review comments arriving in a short window into a single notification. 30 s matches the typical time for a reviewer to finish a GitHub review. A 5-minute cooldown follows each notification to prevent Claude's replies from triggering further notifications. Event cap (default 50) bounds memory.

**`allowed_authors` is mandatory** — prevents noise from unrelated PRs on shared CI infrastructure. Email-format entries support co-author matching for AI pair-programmers (e.g., Devin) that create PRs under bot accounts.

**YAML config with deep merge** — `loadConfig()` merges user YAML against `DEFAULT_CONFIG`; absent fields keep defaults. Environment variables (`WEBHOOK_PORT`, `REVIEW_DEBOUNCE_MS`) still take precedence as an escape hatch for containerised deployments.

**Template interpolation, not code** — `{placeholder}` substitution in instruction strings lets users customise notification text in YAML without writing TypeScript. Intentionally minimal: no conditionals, loops, or escaping.

**Explicit field extraction, no raw payload dump** — notification content uses a fixed set of extracted fields. Raw payloads contain user-controlled strings; explicit extraction limits the prompt-injection attack surface.

**Mux mode (Streamable HTTP)** — a single `claude-beacon-mux` process on `:9444` serves all Claude Code sessions. The original per-session stdio design made webhook routing impossible without a hub process. The mux requires a persistent process (systemd or similar) but eliminates that complexity.

**`fetch_workflow_logs` manual redirect** — GitHub Actions log URLs return HTTP 302 to a presigned S3 URL that rejects `Authorization` headers. We capture the redirect with `redirect: "manual"` and make an unauthenticated request to S3.

---

## Security summary

| Threat | Mitigation |
|---|---|
| Forged webhook | HMAC-SHA256, `timingSafeEqual` |
| Webhook replay | LRU delivery ID deduplication |
| Memory exhaustion | 10 MB size guard before JSON parse |
| Prompt injection | `sanitizeBody()` strips null bytes, bidi overrides, truncates |
| Token exfiltration via redirect | `redirect:"manual"`, unauthenticated S3 fetch |
| Credential leak in logs | Only 8-char token prefix logged |
| Dev-mode bypass in production | Explicit `WEBHOOK_DEV_MODE` env var; logs a warning |
| Session flooding | Debounce + per-PR cooldown + event cap |
