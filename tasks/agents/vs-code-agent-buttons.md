---
title: VS Code agent buttons
status: todo
author: Elijah Allen
created: 2026-10-19
priority: 2
tags:
  - agents
  - vscode
depends_on:
  - agent-runner
  - blocked-status-in-all-views
---

# VS Code agent buttons

## Description

Agent actions in the extension. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (VS Code extension).

## Acceptance criteria

- [ ] **Send to agent** on cards (hover), the tree context menu and the editor title runs `mdpm agent run --task <id>` in a named integrated terminal, using the extension's bundled CLI
- [ ] Setting `mdpm.agent.default` (default `claude`); a quick pick chooses another configured agent
- [ ] **Queue for agent** sets `owner` to an agent without running it
- [ ] **Unblock** on blocked tasks opens the questions and moves the task back to `todo`
- [ ] Cards owned by an agent show a robot badge
