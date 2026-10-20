---
title: Scheduled runs to use spare weekly credits
status: backlog
author: Elijah Allen
created: 2026-10-19
tags:
  - agents
  - credits
depends_on:
  - flow-runner-one-idea-at-a-time
priority: 3
---


# Scheduled runs to use spare weekly credits

## Description

Use subscription usage that would otherwise expire, without getting in the way of interactive work. In the flow, a scheduled run is just `mdpm agent run --until-idle` during quiet hours: every run is useful, because when nothing is approved to execute, the agent plans ideas. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (*Using spare usage*). Rewritten 2026-10-20 for the flow; cloud routines and the git-based claim protocol are dropped.

## Acceptance criteria

- [ ] `mdpm agent schedule install|uninstall|status` sets up the local runner with launchd (macOS), Task Scheduler (Windows) or cron/systemd (Linux). It runs `mdpm agent run --until-idle` and honours `schedule.quietHours`, `weekends` and `weeklyReset`.
- [ ] It runs more often in the last 24–48 hours before `weeklyReset`.
- [ ] Optional: `mdpm agent statusline` records Claude Code's `rate_limits` to `~/.mdpm/usage.json`, and the scheduler uses it as a hint.
- [ ] `status` shows the last scheduled run, what it did (planned or executed which idea), and the next scheduled time.
- [ ] The docs include a note to check Anthropic's usage terms for unattended runs.

## Verification

- `npm run typecheck && npm test`
- On macOS: `mdpm agent schedule install`, then check `launchctl list | grep mdpm` and `mdpm agent schedule status`. Remove it again with `uninstall`.

## Questions
