---
title: Ready-for-agent criteria and task template
status: done
author: Elijah Allen
created: 2026-10-19
tags:
  - agents
priority: 2
completed: 2026-10-19
---

# Ready-for-agent criteria and task template

## Idea

Define when a task is ready for an agent to implement, and a template that makes tasks ready by default. Tasks that aren't ready get the `refine` mode instead. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (What an agent works on next).

## Acceptance criteria

- [x] Written criteria: a task is ready when it has acceptance criteria (at least one `- [ ]` item with text) and, ideally, a verification section (commands/tests that prove it works)
- [x] The criteria are implemented as a function `mdpm next` uses, plus an optional validator warning for agent-owned `todo` tasks that aren't ready
- [x] A task template (Goal, Context, Acceptance criteria, Verification, Constraints, Questions) used by `mdpm new --template agent` and the VS Code New Task command

## Log

- 2026-10-19 10:26 claude — claimed (run session-2026-10-19)
- 2026-10-19 10:27 claude — handed off for review: readiness() in packages/core/src/body.ts: ready = at least one '- [ ] text' item under '## Acceptance criteria' (HTML comments ignored); a Verification section is reported but optional. mdpm next uses it (todo without criteria gets refine). New warning task/not-ready for agent-owned todo tasks. 'agent' template (Goal, Context, Acceptance criteria, Verification, Constraints, Questions) via mdpm new --template agent and VS Code New Task (setting mdpm.taskTemplate, default agent). Tests in agent.test.ts.
