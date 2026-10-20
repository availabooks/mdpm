---
title: "Agent init: skill and AGENTS.md"
status: done
author: Elijah Allen
created: 2026-10-19
priority: 2
tags:
  - agents
completed: 2026-10-19
---

# Agent init: skill and AGENTS.md

## Idea

Teach agents the protocol in the formats they read. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Teaching agents the protocol).

## Acceptance criteria

- [x] `mdpm agent init` writes `.claude/skills/mdpm/SKILL.md` and an `AGENTS.md` section between markers; re-running updates in place without touching other content
- [x] The instructions cover: finding work (`mdpm next`), modes, claiming, logging, when to block instead of guessing, handing off to review, never marking done, editing only the task body directly
- [x] `--claude-hook` adds a Claude Code Stop hook that runs `mdpm check --task "$MDPM_TASK"` and blocks finishing while the task is invalid or left without a handoff/block/log entry
- [x] Run against this repo and commit the generated files

## Log

- 2026-10-19 10:26 claude — claimed (run session-2026-10-19)
- 2026-10-19 10:27 claude — handed off for review: mdpm agent init writes .claude/skills/mdpm/SKILL.md and an AGENTS.md section between markers (re-runs replace only that part; tested). Content covers next, modes, claim, log, block-instead-of-guessing, handoff, never done, body-only edits. --claude-hook adds a Stop hook ([ -z $MDPM_TASK ] || mdpm check --hook) that exits 2 while the task is invalid or has nothing written back since the claim, and lets go on the second stop (stop_hook_active). Generated files are in the repo but NOT committed yet, and the hook was not added to this repo: both wait for Eli.
