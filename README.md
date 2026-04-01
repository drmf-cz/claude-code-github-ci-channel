# claude-code-github-ci-channel

> MCP channel plugin that pushes GitHub Actions CI/CD results into running Claude Code sessions.

Built on the [Claude Code Channels](https://docs.anthropic.com/en/docs/claude-code) API (research preview, v2.1.80+).

## Overview

When a CI run completes on GitHub Actions, this plugin delivers a structured notification directly into your Claude Code session — with failure details, step names, and a tool to fetch full logs on demand.

```
GitHub Actions → webhook → MCP channel server → Claude Code session
```

## Status

🚧 Under active development — see [Issues](../../issues) for progress.
