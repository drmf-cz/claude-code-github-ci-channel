# Contributing to claude-beacon

## Before you start

Read [`CLAUDE.md`](CLAUDE.md) for the development workflow, code standards, and security review requirements. That file is the authoritative source of truth for this project.

## Workflow at a glance

1. Fork (or branch if you have write access)
2. Open a **draft PR** before writing code — CI validates every push
3. Follow the security-first review checklist in `CLAUDE.md`
4. Bump the version in `package.json` and update `CHANGELOG.md`
5. Mark the PR ready when all checks pass

## What we care about most

### Security

Every field that flows from a GitHub webhook into a Claude Code notification is a potential prompt injection vector. Before embedding any new field in a notification string, ask:

- Is this field user-controlled? (commit message, PR title, branch name — yes)
- Is it passing through `sanitizeBody()`? (it must)
- Could it contain Unicode bidi-override characters? (sanitiser strips these)

If you are not sure, add a test that tries to inject a bidi-override character through the new field and assert it is stripped.

### TypeScript strictness

We run the strictest TypeScript settings available. No `any`, no type assertions without a comment explaining why they are safe, no index access without `noUncheckedIndexedAccess` guards. Run `bun run typecheck` before pushing.

### Tests

Every new exported function needs tests. See `src/__tests__/` for examples. We use `bun:test` — no additional test framework needed.

## Local setup

```bash
git clone git@github.com:drmf-cz/claude-beacon.git
cd claude-beacon
bun install
bun test
```

Requirements: [Bun](https://bun.sh) ≥ 1.1.

## Running the checks

```bash
bun test              # unit tests
bun run typecheck     # TypeScript — must be zero errors
bun run lint          # Biome v2 — must be zero violations
bun run lint:fix      # auto-fix what Biome can fix
bun run build         # bundle to dist/
```

## Adding a new GitHub event type

1. Add interfaces to `src/types.ts`
2. Add a `parse*Event()` function in `src/server.ts`
3. Add the event type to `isActionable()` if it should produce notifications
4. Route it in `startWebhookServer()`
5. Sanitise every user-controlled field through `sanitizeBody()`
6. Add tests: happy path, skip path, and sanitisation of user-controlled fields
7. Document the new event in `README.md` and in `AGENTS.md`

## Reporting security issues

Do **not** open a public issue for security vulnerabilities. Contact the maintainer directly before disclosing.

For everything else — bugs, feature requests, questions — GitHub Issues are the right place.
