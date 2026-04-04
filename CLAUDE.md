# CLAUDE.md — claude-beacon

This file is the authoritative guide for AI agents (Claude Code) working in this repository.

## What this repo is

`claude-beacon` is a Claude Code MCP plugin that pushes GitHub CI/PR webhook events into live Claude Code sessions as actionable notifications. It bridges GitHub webhooks → HMAC-verified HTTP receiver → MCP `notifications/claude/channel` method → Claude Code session.

It is **not** a general web server. Every design decision optimises for: minimal attack surface, zero accidental data leaks, and notifications that Claude can act on autonomously.

## Session startup — REQUIRED

**At the start of every session working in this repo, call `set_filter` immediately:**

```
set_filter(
  repo: "drmf-cz/claude-beacon",
  branch: <output of `git branch --show-current`>,
  label: <same branch name>,
  worktree_path: <output of `git rev-parse --show-toplevel`>
)
```

This registers the session with the running mux server so CI/PR notifications are routed here. Without this call the session is invisible to the mux and all notifications are dropped (they are queued for up to 2 hours, so calling `set_filter` late will still replay missed events).

Call `set_filter` again after checking out a different branch or entering/leaving a worktree.

## Skills available in this repo

Two skills are defined in `.claude/commands/`. Use them — do not replicate their logic inline.

**`security-review`** — Use this skill whenever:
- You are about to push or merge changes that touch any file in `src/`
- You are asked to review a PR
- You are asked to check security
- You have just written new code and want to verify it is safe

**`review-pr`** — Use this skill whenever:
- You are asked to review a PR or check if something is ready to merge
- You have finished implementing a feature and want to self-review before pushing
- Someone asks "is this ready?" or "can we merge?"

The `review-pr` skill calls `security-review` internally for `src/` changes — you do not need to run both manually.

## Repository structure

```
src/
├── index.ts      # Entrypoint: wires HTTP server + MCP stdio transport
├── mux.ts        # Multi-session entrypoint: persistent HTTP server, all sessions connect
├── server.ts     # Core: HMAC verification, event parsing, MCP server, fetch_workflow_logs
├── config.ts     # Config loading, deep merge, template interpolation
├── types.ts      # GitHub webhook payload interfaces
└── ghwatch.ts    # Option B: GitHub Events API poller (no webhook/tunnel)

src/__tests__/
├── server.test.ts  # All server.ts unit tests
└── config.test.ts  # Config loading and interpolation tests

docs/
├── ARCHITECTURE.md          # Design decisions and rationale
├── multi-session.md         # Mux server setup guide
└── worktree-integration.md  # Native worktree mode guide

.claude/skills/
├── security-review/SKILL.md  # Security audit skill
└── review-pr/SKILL.md        # Full PR review skill

.github/
└── PULL_REQUEST_TEMPLATE.md  # PR checklist (mirrors merge checklist below)
```

## Development workflow — ALWAYS follow this

**Every change goes on a branch. Every branch gets a draft PR before work starts.**

```bash
# 1. Create a branch from main
git checkout -b feat/your-feature   # or fix/..., docs/..., refactor/...

# 2. Open a draft PR immediately (before writing code)
gh pr create --draft --title "feat: short description" --body "$(cat .github/PULL_REQUEST_TEMPLATE.md)"

# 3. Work on the branch, push often
git push -u origin feat/your-feature

# 4. When ready, mark the PR ready for review
gh pr ready
```

Why draft PRs: CI runs on every push, the version-bump check enforces progress, and the branch is visible to collaborators.

## Code quality checks — run before every push

```bash
bun test            # All tests must pass
bun run typecheck   # Zero TypeScript errors
bun run lint        # Biome v2 — zero violations
bun run build       # Bundle must succeed
```

CI enforces all four. A failing CI on any non-draft PR blocks merge.

## Security standards

Security review is **mandatory** on every PR that touches `src/`. Use the `security-review` skill — it covers the full checklist. The five areas it checks:

1. **Input boundaries** — all webhook payload fields embedded in notifications must pass through `sanitizeBody()`
2. **Authentication paths** — `verifySignature()` must be the first gate, before any JSON parsing
3. **Token handling** — `GITHUB_TOKEN` must only be sent to `api.github.com`; use `redirect: "manual"` on GitHub redirects
4. **Information leaks** — no full tokens in logs, no raw request content in error responses
5. **Replay and DoS** — `isOversized()` before JSON parse, `isDuplicateDelivery()` before processing

See `docs/ARCHITECTURE.md` for the rationale behind each guard.

## TypeScript standards

- **Zero `any`** — enforced by Biome `noExplicitAny: error`
- All function parameters and return types must be explicit
- Use discriminated unions (e.g. `MergeableState`) — do not use `string` for fields with known values
- `tsconfig.json` is maximally strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`) — do not relax any flag

## Testing standards

- Every new exported function must have unit tests
- Security-critical functions (`verifySignature`, `sanitizeBody`, `isDuplicateDelivery`, `isOversized`) require tests for both the happy path and the failure/edge-case path
- New event parse functions must test: successful parse, skipped events, and sanitisation of user-controlled fields

## Commit message format

```
<type>: <imperative short description>

# Types: feat, fix, docs, refactor, test, ci, chore
```

## Versioning

Every merged PR **must** bump `package.json` version (enforced by CI).

**Rule: if a PR contains even one new feature, bump minor — not patch.**

| Change type | Bump | Example |
|---|---|---|
| Bug fixes, docs, tests, refactors with no behaviour change | `patch` (1.1.x) | 1.3.2 → 1.3.3 |
| New features, new config options, new default behaviours | `minor` (1.x.0) | 1.3.x → 1.4.0 |
| Breaking config changes, removed fields | `major` (x.0.0) | 1.x.x → 2.0.0 |

**Mixed PRs** (fixes + features) always take the highest applicable bump — a PR that has both a bug fix and a new feature is a `minor` bump. When in doubt, check the commit list: any `feat:` commit → minor.

Update `CHANGELOG.md` with every version bump.

## Release tagging — REQUIRED after every merge to main

After any PR merges to main, check whether a release tag is needed:

```bash
# 1. Get the version currently on main
git fetch origin main
CURRENT=$(git show origin/main:package.json | grep '"version"' | grep -oP '[\d.]+')

# 2. Check if that tag already exists
git fetch --tags
if git rev-parse "v${CURRENT}" >/dev/null 2>&1; then
  echo "v${CURRENT} already tagged — nothing to do"
else
  echo "MISSING tag v${CURRENT} — creating it"
  # Tag the latest merge commit on main (the one that contains the version bump)
  MERGE_COMMIT=$(git log --oneline --merges origin/main | head -1 | awk '{print $1}')
  git tag "v${CURRENT}" "$MERGE_COMMIT"
  git push origin "v${CURRENT}"
fi
```

**Rules:**
- Always tag the **merge commit** on main (not the version-bump commit inside the branch)
- One tag per version — skip if the tag already exists
- Run this check whenever asked to "tag releases", "create a release", or after merging a PR

## Merge checklist

Before marking a PR ready, use the `review-pr` skill. It runs all checks automatically. The checklist it verifies:

- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run build` passes
- [ ] Security review passed (for `src/` changes)
- [ ] Version bumped in `package.json`
- [ ] `CHANGELOG.md` updated with today's date and correct version
- [ ] New config fields documented in `README.md` and `config.example.yaml`
- [ ] New event types documented in `README.md` and `AGENTS.md`
