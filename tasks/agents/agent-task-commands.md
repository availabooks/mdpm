---
title: Agent task commands
status: todo
author: Elijah Allen
created: 2026-10-19
priority: 1
tags:
  - agents
  - cli
depends_on:
  - blocked-status-in-all-views
end: 2026-10-19
---

# Agent task commands

## Description

The CLI commands agents use to find work and write back to tasks. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (sections "What an agent works on next" and "How an agent writes back").

## Acceptance criteria

- [ ] `mdpm next --agent <name> [--json]` returns the best eligible task and its mode (`resume`/`implement`/`refine`), following the eligibility and ranking rules in the design (assigned before unassigned; `agent.enabled`, `agent.unassigned`, `agent.modes` in `.proj`)
- [ ] `mdpm claim`, `log`, `block`, `handoff`, `release` work as specified, validate before writing, support `--json`, and append signed, timestamped entries to `## Agent log`
- [ ] `block` appends questions as `- [ ]` items under `## Questions`; `handoff` records `branch:`/`pr:`
- [ ] With `MDPM_AGENT` set, the CLI refuses `status: done` and changes to tasks the agent hasn't claimed
- [ ] `claim` refuses a task that is already claimed by another agent (local check; git-based claims come later in `agent-claim-and-lock-protocol`)
- [ ] New `.proj` settings (`agent.*`) are validated and documented; tests cover selection, ranking and every command
