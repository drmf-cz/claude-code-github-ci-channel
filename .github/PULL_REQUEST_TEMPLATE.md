## What

<!-- One paragraph: what does this PR do? -->

## Why

<!-- Why is this change needed? Link issues if relevant. -->

## Security review

<!-- Required for any src/ change. Run the security-review skill or check manually. -->

- [ ] No new webhook payload field reaches notification content without passing through `sanitizeBody()`
- [ ] `verifySignature()` is still the first gate in the webhook handler
- [ ] No `fetch()` call forwards `Authorization` to a non-`api.github.com` host
- [ ] No tokens or secrets appear in log output (only 8-char prefix is acceptable)
- [ ] `isOversized()` and `isDuplicateDelivery()` guards are intact on all request paths

_If this PR does not touch `src/`, check "N/A — no src/ changes" and delete the items above._

- [ ] N/A — no src/ changes

## Checklist

- [ ] `bun test` passes
- [ ] `bun run typecheck` passes (zero errors)
- [ ] `bun run lint` passes (zero violations)
- [ ] `bun run build` passes
- [ ] Version bumped in `package.json`
- [ ] `CHANGELOG.md` updated with today's date and correct version
- [ ] New config fields documented in `README.md` and `config.example.yaml`
- [ ] New event types documented in `README.md` events table and `AGENTS.md`
