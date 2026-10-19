---
title: Agent claim and lock protocol
status: backlog
author: Elijah Allen
created: 2026-10-19
tags:
  - agents
depends_on:
  - agent-task-commands
priority: 3
---

# Agent claim and lock protocol

## Description

Make claims safe when several agents run at once, on different machines or in the cloud, where task-state changes travel through git. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Scheduling, option B; Decisions 3).

## Acceptance criteria

- [ ] Design and implement git-based claims: a claim is a commit to the default branch touching only the task file; a rejected push means someone else got there first, and the agent re-picks
- [ ] Stale claims (no log entry for a configurable time) can be taken over, with a log entry saying so
- [ ] Works with Claude Code routines (they clone the default branch and push `claude/…` branches)
- [ ] Documented, with tests for the conflict cases
