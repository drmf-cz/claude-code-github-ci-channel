---
description: Perform a security-focused audit of changes in this repo. Use this whenever src/ files are modified, before marking a PR ready, or when asked to do a security review. Checks input sanitisation, auth paths, token handling, info leaks, and replay/DoS guards.
allowed-tools: Grep Glob Read Bash
---

You are doing a security review of changes to `claude-beacon`. This is a GitHub webhook receiver that injects content into Claude Code sessions — prompt injection is the primary threat model.

Work through each area in order. Report every finding with file path, line number, severity, and recommended fix. Do not skip areas even if the diff looks unrelated.

## 1. Input boundaries — HIGHEST PRIORITY

Every field from a GitHub webhook payload that ends up in a notification string is a potential prompt injection vector.

```bash
# Find all payload field accesses
grep -n "payload\." src/server.ts | grep -v "^\s*//"
# Find sanitizeBody call sites
grep -n "sanitizeBody" src/server.ts
# Find string template construction for notifications
grep -n "content:" src/server.ts
```

For each field embedded in `CINotification.content` or any review notification string:
- Is it passed through `sanitizeBody()` before use?
- Does `sanitizeBody()` strip null bytes AND Unicode bidi-override characters (U+200B–U+202E, U+2066–U+2069)?
- Is the result truncated to `MAX_BODY_CHARS`?

**HIGH** if any user-controlled field reaches notification content without sanitisation.

## 2. Authentication paths

```bash
grep -n "verifySignature\|WEBHOOK_DEV_MODE\|isOversized\|isDuplicateDelivery" src/server.ts
```

Verify in the webhook request handler:
1. `isOversized()` is called before reading the body into memory
2. `verifySignature()` is called before any JSON parsing
3. `isDuplicateDelivery()` is called before event processing
4. `WEBHOOK_DEV_MODE` only skips `verifySignature()`, not the other guards
5. No new route or handler bypasses this sequence

**HIGH** if the order is wrong or a guard is missing on any path.

## 3. Token handling

```bash
grep -n "GITHUB_TOKEN\|Authorization\|fetch(" src/server.ts
```

For every `fetch()` call:
- Is the `Authorization` header only sent to URLs starting with `https://api.github.com`?
- When following a GitHub redirect (e.g., to S3 for log files), is `redirect: "manual"` used so the token is not forwarded?

**HIGH** if `Authorization` can be forwarded to a non-GitHub host.

## 4. Information leaks

```bash
grep -n "console\." src/server.ts
grep -n "return new Response" src/server.ts
```

- Log lines must not contain full tokens — only the first 8 characters are acceptable.
- The `/health` endpoint must return only `{"status":"ok","server":"claude-beacon"}`.
- Error responses (4xx, 5xx) must not echo back raw request content or internal paths.

**MEDIUM** if non-public data appears in logs or responses.

## 5. Replay and DoS guards

```bash
grep -n "isDuplicateDelivery\|isOversized\|MAX_BODY" src/server.ts
```

- Confirm the 10 MB body size guard fires before `JSON.parse()`.
- Confirm delivery ID deduplication fires before any notification is emitted.
- No new codepath that processes webhook content bypasses these checks.

## Output

Group findings by severity:

**HIGH** — Unsanitised payload field in notification, auth bypass, token forwarded to untrusted host.  
**MEDIUM** — Partial mitigation present but incomplete, info leak of non-public data.  
**LOW** — Dev-mode risk, edge-case missing guard.  
**INFO** — Defence-in-depth suggestions.

Each finding: `severity | file:line | description | recommended fix`

If no findings in an area, write "✓ area-name — no issues found."  
End with a one-line verdict: **PASS**, **PASS WITH NOTES**, or **FAIL**.
