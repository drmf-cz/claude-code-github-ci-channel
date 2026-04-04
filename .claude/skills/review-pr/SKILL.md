---
description: Review a PR in this repo for correctness, security, and project standards compliance. Use this when asked to review a PR, check if code is ready to merge, or validate changes before pushing. Runs security audit, typecheck, tests, lint, and verifies docs and version bump.
allowed-tools: Grep Glob Read Bash
---

You are reviewing a pull request in `claude-beacon`. Work through each step in order. Security comes first — do not skip it even for docs-only PRs.

Start by identifying what changed:

```bash
git diff main...HEAD --name-only
git log --oneline main..HEAD
```

## Step 1 — Security review (mandatory for any src/ change)

Use the `security-review` skill now. If any `src/` file appears in the diff, this step is non-negotiable.

If the diff contains only docs, config, or test files with no new payload field accesses, note "security review skipped — no src/ changes" and move on.

## Step 2 — TypeScript correctness

```bash
bun run typecheck
```

- Zero errors required.
- Flag any new explicit `any` cast or `as SomeType` assertion that lacks a comment explaining why it is safe.

## Step 3 — Tests

```bash
bun test
```

All tests must pass. Then check coverage for new code:

```bash
git diff main...HEAD -- src/ | grep "^+export function\|^+export async function"
```

For every new exported function in the diff:
- Is there a test in `src/__tests__/`?
- Does it cover both the happy path and at least one error/edge-case?
- For security-critical functions (`verifySignature`, `sanitizeBody`, `isDuplicateDelivery`, `isOversized`): are failure paths tested explicitly?

## Step 4 — Linting

```bash
bun run lint
```

Zero Biome violations. If violations exist, run `bun run lint:fix` and check whether auto-fix resolved them or they need manual attention.

## Step 5 — Documentation

```bash
git diff main...HEAD -- README.md config.example.yaml AGENTS.md CHANGELOG.md
```

- New config fields → must appear in both `README.md` YAML config section and `config.example.yaml`.
- New event types → must appear in `README.md` events table and `AGENTS.md` key exports table.
- Breaking changes → must be in `CHANGELOG.md` under the correct version with `### Changed` or `### Removed`.

## Step 6 — Version bump

```bash
grep '"version"' package.json
git show main:package.json | grep '"version"'
```

The version in the branch must be higher than the version on main. No merge without a bump — CI enforces this but confirm it here.

## Step 7 — CHANGELOG entry

```bash
grep -A 10 "## \[" CHANGELOG.md | head -20
```

- The top entry version must match `package.json`.
- The date must be today in `YYYY-MM-DD` format.
- The entry must list actual changes, not placeholder text.

## Output

Report each step as:
- ✓ **Step name** — one-line summary
- ✗ **Step name** — list of issues with `file:line` references

End with one of:

**APPROVE** — all steps pass, ready to merge.  
**REQUEST CHANGES** — list each blocking item that must be fixed before merge.  
**COMMENT** — all required checks pass but there are non-blocking suggestions.
