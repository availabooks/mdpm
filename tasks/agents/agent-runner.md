---
title: Agent runner
status: todo
author: Elijah Allen
created: 2026-10-19
priority: 2
tags:
  - agents
  - cli
depends_on:
  - agent-task-commands
  - agent-init-skill-and-agents-md
---

# Agent runner

## Description

`mdpm agent run`: pick, claim, run an agent CLI in an isolated worktree, record the result. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Running agents).

## Acceptance criteria

- [ ] Presets for `claude` (default), `cursor` and `codex`; custom agents as argument lists with placeholders, configured in the root `.proj` (`agents:`), validated
- [ ] Each task runs in a worktree on branch `agent/<task-id>`; task-state edits go to the main checkout (`MDPM_ROOT`); worktrees are cleaned up after handoff
- [ ] On handoff the branch is pushed and a PR opened with `gh` when available, and `pr:` recorded
- [ ] `--task`, `--agent`, `--max-tasks`, `--dry-run`; per-task `--max-turns` default 50
- [ ] A usage-limit message ends the loop cleanly: the task stays resumable and the reset time is recorded (verify the actual `claude -p` behaviour first)
- [ ] Run records in `.mdpm/runs/` (git-ignored) with agent, task, duration, exit code, session id and cost if reported; `resume` mode reuses the session id where the agent supports it
- [ ] Works on Windows, macOS and Linux (no shell strings)
