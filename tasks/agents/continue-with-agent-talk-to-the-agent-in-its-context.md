---
title: "Continue with Agent: talk to the agent in its context"
status: done
owner: claude
author: Elijah Allen
created: 2026-10-19
priority: 2
tags:
  - agents
  - vscode
depends_on:
  - agent-runner
start: 2026-10-19
branch: agent/continue-with-agent
end: 2026-10-19
---

# Continue with Agent: talk to the agent in its context

## Description

Click a task and open the agent that worked on it, with its conversation, so you can give it more directions. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Continuing a conversation).

## Acceptance criteria

- [x] `mdpm agent continue <task>` reopens the agent's last conversation in the task's worktree (Claude: `claude --continue`), or starts a new one from the task, its log and its questions when there is none (or with `--fresh`)
- [x] A worktree removed after a handoff is recreated on the task's `agent/<id>` branch first; `--dry-run` creates nothing
- [x] The agent is the one from the task's last run, else its owner, else the default; `--agent` overrides; agents without an `interactive` command get an error that says what to add to the root `.proj`
- [x] The session is interactive (permission prompts go to the person) and `MDPM_AGENT` is not set; the task's Agent log records that a session was opened
- [x] VS Code: **Continue with Agent** on agent-owned cards (💬), the task context menu and the editor title opens a terminal `mdpm · chat · <id>`
- [x] Tests cover planning (reopen vs new, recreated worktree, agent choice, missing interactive command, dry run, exit code); README and design doc updated

## Verification

- `npm test`, `npm run typecheck`, `npm run build`, `mdpm check --strict`
- Verified against the real `claude` CLI: a session started in a worktree can be resumed with `--resume` and `--continue` after the worktree is removed and recreated at the same path, and `--continue` accumulates directions across sessions.

## Agent log

- 2026-10-19 14:12 claude — claimed (run session-2026-10-19)
- 2026-10-19 14:12 claude — handed off for review: Built mdpm agent continue (core planContinue/runInteractive, CLI, VS Code button/menus/title), tests, docs. Not verified: driving the interactive Claude TUI itself and clicking the VS Code button; the pieces underneath were checked (real claude --continue after worktree recreation, dry runs, unit tests). Also fixed main's failing CI: the webview tests' fake DOM lacked querySelectorAll and captured the wrong window listener after the multi-select merge.
