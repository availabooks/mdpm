---
title: Ready-for-agent criteria and task template
status: todo
author: Elijah Allen
created: 2026-10-19
tags:
  - agents
depends_on:
  - design-the-agent-workflow
priority: 2
---

# Ready-for-agent criteria and task template

## Description

Define when a task is ready for an agent to implement, and a template that makes tasks ready by default. Tasks that aren't ready get the `refine` mode instead. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (What an agent works on next).

## Acceptance criteria

- [ ] Written criteria: a task is ready when it has acceptance criteria (at least one `- [ ]` item with text) and, ideally, a verification section (commands/tests that prove it works)
- [ ] The criteria are implemented as a function `mdpm next` uses, plus an optional validator warning for agent-owned `todo` tasks that aren't ready
- [ ] A task template (Goal, Context, Acceptance criteria, Verification, Constraints, Questions) used by `mdpm new --template agent` and the VS Code New Task command
