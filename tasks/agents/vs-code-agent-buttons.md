---
title: VS Code agent buttons
status: done
author: Elijah Allen
created: 2026-10-19
priority: 2
tags:
  - agents
  - vscode
depends_on:
  - agent-runner
  - blocked-status-in-all-views
owner: claude
start: 2026-10-19
end: 2026-10-19
---

# VS Code agent buttons

## Description

Agent actions in the extension. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (VS Code extension).

## Acceptance criteria

- [x] **Send to agent** on cards (hover), the tree context menu and the editor title runs `mdpm agent run --task <id>` in a named integrated terminal, using the extension's bundled CLI
- [x] Setting `mdpm.agent.default` (default `claude`); a quick pick chooses another configured agent
- [x] **Queue for agent** sets `owner` to an agent without running it
- [x] **Unblock** on blocked tasks opens the questions and moves the task back to `todo`
- [x] Cards owned by an agent show a robot badge

## Agent log

- 2026-10-19 10:26 claude — claimed (run session-2026-10-19)
- 2026-10-19 10:27 claude — handed off for review: Send to Agent (card hover button, tree inline/context menu, editor title) runs the bundled CLI (dist/mdpm.js, built with the extension) via VS Code's runtime in a terminal 'mdpm · <agent> · <id>' with no shell; ▾ / Send to Agent… picks another agent; setting mdpm.agent.default (claude). Queue for Agent… sets owner and logs. Unblock (blocked cards, tree, editor title) opens ## Questions and moves to todo. Agent-owned cards and tree rows show 🤖. Typechecks and packages with vsce; not yet clicked through in a running VS Code.
