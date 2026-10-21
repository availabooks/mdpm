---
title: Agent runner
status: done
author: Elijah Allen
created: 2026-10-19
priority: 2
tags:
  - agents
  - cli
completed: 2026-10-19
---

# Agent runner

## Idea

`mdpm agent run`: pick, claim, run an agent CLI in an isolated worktree, record the result. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Running agents).

## Acceptance criteria

- [x] Presets for `claude` (default), `cursor` and `codex`; custom agents as argument lists with placeholders, configured in the root `.proj` (`agents:`), validated
- [x] Each task runs in a worktree on branch `agent/<task-id>`; task-state edits go to the main checkout (`MDPM_ROOT`); worktrees are cleaned up after handoff
- [x] On handoff the branch is pushed and a PR opened with `gh` when available, and `pr:` recorded
- [x] `--task`, `--agent`, `--max-tasks`, `--dry-run`; per-task `--max-turns` default 50
- [ ] A usage-limit message ends the loop cleanly: the task stays resumable and the reset time is recorded (verify the actual `claude -p` behaviour first)
- [x] Run records in `.mdpm/runs/` (git-ignored) with agent, task, duration, exit code, session id and cost if reported; `resume` mode reuses the session id where the agent supports it
- [ ] Works on Windows, macOS and Linux (no shell strings)

## Log

- 2026-10-19 10:26 claude — claimed (run session-2026-10-19)
- 2026-10-19 10:27 claude — handed off for review: mdpm agent run in packages/core/src/runner.ts: presets claude/codex/cursor plus validated custom agents (argument lists, placeholders, stdin), worktree per task on agent/<id> under .mdpm/worktrees, task state in MDPM_ROOT, mdpm shims on the agent's PATH, push + gh pr create on handoff with pr: recorded, worktree removed after handoff, --task/--agent/--max-tasks/--max-turns/--dry-run, run records in .mdpm/runs (self-ignoring), Claude session resume, usage-limit stop with reset gate, no shell (Windows .cmd via quoted cmd.exe). Tested end to end with fake agents (handoff, limit, no-handoff, dry run). Left unticked: a real usage-limit message is still unverified (detection is pattern-based; see docs/agent-workflow.md) and Windows is untested beyond unit tests of the quoting. Also not yet exercised: a real claude run on a task and the push/PR path against a real remote.
