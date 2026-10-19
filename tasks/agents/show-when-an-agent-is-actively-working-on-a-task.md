---
title: Show when an agent is actively working on a task
status: review
owner: claude
author: Elijah Allen
created: 2026-10-19
priority: 2
tags:
  - agents
  - vscode
start: 2026-10-19
branch: agent/agent-activity-indicator
---

# Show when an agent is actively working on a task

## Description

A task sitting in Todo could be queued, being refined or being built, and nothing said which. Show it in every view. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Showing activity).

## Acceptance criteria

- [x] Runs and interactive sessions write a heartbeat marker under `.mdpm/active/`, removed on exit and on INT/TERM/HUP; killed runs expire on their own
- [x] Board and flow board cards show a pulsing "agent verb · time" badge and glow while running, and a quiet "queued" badge for agent-owned tasks waiting for a run
- [x] The Projects tree shows a spinning icon and the agent's activity; the status bar shows how many agents are working
- [x] `mdpm agent status`, `list`, `show` and `--json` show running tasks
- [x] A task already being worked on can't be started again (run, chat, or a second runner picking tasks); Send/Continue buttons are hidden while it runs
- [x] Tests cover markers, expiry, the runner, the double-start guard, chat sessions and the card badges

## Verification

- `npm test`, `npm run typecheck`, `npm run build`, `mdpm check --strict`
- With a slow stand-in agent: `mdpm agent status` shows it while it runs; Ctrl-C clears it at once; `kill -9` leaves a file that is ignored

## Agent log

- 2026-10-19 14:59 claude — claimed (run session-2026-10-19)
- 2026-10-19 14:59 claude — handed off for review: Activity markers + badges/spinner/status bar + CLI + double-start guard, with tests and a live check using a slow stand-in agent (status while running, SIGINT, kill -9). Not checked: the real VS Code UI (pulse/glow, tree spinner, status bar) has not been looked at.
