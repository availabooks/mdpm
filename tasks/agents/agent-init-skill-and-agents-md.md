---
title: "Agent init: skill and AGENTS.md"
status: todo
author: Elijah Allen
created: 2026-10-19
priority: 2
tags:
  - agents
depends_on:
  - agent-task-commands
---

# Agent init: skill and AGENTS.md

## Description

Teach agents the protocol in the formats they read. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Teaching agents the protocol).

## Acceptance criteria

- [ ] `mdpm agent init` writes `.claude/skills/mdpm/SKILL.md` and an `AGENTS.md` section between markers; re-running updates in place without touching other content
- [ ] The instructions cover: finding work (`mdpm next`), modes, claiming, logging, when to block instead of guessing, handing off to review, never marking done, editing only the task body directly
- [ ] `--claude-hook` adds a Claude Code Stop hook that runs `mdpm check --task "$MDPM_TASK"` and blocks finishing while the task is invalid or left without a handoff/block/log entry
- [ ] Run against this repo and commit the generated files
