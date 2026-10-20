---
title: Agent task commands
status: done
author: Elijah Allen
created: 2026-10-19
priority: 1
tags:
  - agents
  - cli
completed: 2026-10-19
---

# Agent task commands

## Idea

The CLI commands agents use to find work and write back to tasks. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (sections "What an agent works on next" and "How an agent writes back").

## Acceptance criteria

- [x] `mdpm next --agent <name> [--json]` returns the best eligible task and its mode (`resume`/`implement`/`refine`), following the eligibility and ranking rules in the design (assigned before unassigned; `agent.enabled`, `agent.unassigned`, `agent.modes` in `.proj`)
- [x] `mdpm claim`, `log`, `block`, `handoff`, `release` work as specified, validate before writing, support `--json`, and append signed, timestamped entries to `## Agent log`
- [x] `block` appends questions as `- [ ]` items under `## Questions`; `handoff` records `branch:`/`pr:`
- [x] With `MDPM_AGENT` set, the CLI refuses `status: done` and changes to tasks the agent hasn't claimed
- [x] `claim` refuses a task that is already claimed by another agent (local check; git-based claims come later in `agent-claim-and-lock-protocol`)
- [x] New `.proj` settings (`agent.*`) are validated and documented; tests cover selection, ranking and every command

## Log

- 2026-10-19 10:26 claude — claimed (run session-2026-10-19)
- 2026-10-19 10:27 claude — handed off for review: mdpm next (--agent, --all, --json; eligibility, modes, ranking and skip reasons), claim/log/block/handoff/release (validated incl. the body, --json, signed log entries, Questions, branch/pr), MDPM_AGENT guard (no final status, only claimed tasks), claim refuses tasks someone else owns (--force takes over). agent.* settings inherited key by key and validated; documented in README. Choices beyond the design: refine claims keep the status; next skips a task whose last log entry is the agent's release until someone logs on it. Tests cover selection, ranking, every write-back and the guard.
