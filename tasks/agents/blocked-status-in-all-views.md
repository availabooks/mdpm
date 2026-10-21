---
title: Blocked status in all views
status: done
author: Elijah Allen
created: 2026-10-19
priority: 1
tags:
  - agents
  - ui
completed: 2026-10-19
---

# Blocked status in all views

## Idea

Add a `blocked` status that agents (and people) use when a task can't move forward without an answer. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Lifecycle).

## Acceptance criteria

- [x] `DEFAULT_STATUSES` and `mdpm init` become `backlog, todo, in-progress, blocked, review, done`; this repo's `tasks/.proj` gets `blocked`
- [x] A status named `blocked` is yellow on the board (column header and cards), in the tree (icon) and on the waterfall (bars)
- [x] New validator rule `task/blocked-without-question` (warning): a blocked task should have at least one open `- [ ]` item under `## Questions`
- [x] README documents `blocked` and the new rule; tests cover the rule

## Log

- 2026-10-19 10:26 claude — claimed (run session-2026-10-19)
- 2026-10-19 10:27 claude — handed off for review: blocked is in DEFAULT_STATUSES, mdpm init and tasks/.proj (with requiredByStatus blocked: [owner]). Yellow column/cards on the board, warning icon in the tree, yellow bars on the waterfall (yellow taken out of the other statuses' colours); the CLI board/list/show highlight it too. New rule task/blocked-without-question with tests; README updated. Verified: npm test, typecheck, build, mdpm check --strict. Not checked by eye in VS Code yet.
