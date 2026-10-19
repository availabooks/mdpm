---
title: Blocked status in all views
status: todo
author: Elijah Allen
created: 2026-10-19
priority: 1
tags:
  - agents
  - ui
depends_on:
  - design-the-agent-workflow
---

# Blocked status in all views

## Description

Add a `blocked` status that agents (and people) use when a task can't move forward without an answer. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Lifecycle).

## Acceptance criteria

- [ ] `DEFAULT_STATUSES` and `mdpm init` become `backlog, todo, in-progress, blocked, review, done`; this repo's `tasks/.proj` gets `blocked`
- [ ] A status named `blocked` is yellow on the board (column header and cards), in the tree (icon) and on the waterfall (bars)
- [ ] New validator rule `task/blocked-without-question` (warning): a blocked task should have at least one open `- [ ]` item under `## Questions`
- [ ] README documents `blocked` and the new rule; tests cover the rule
