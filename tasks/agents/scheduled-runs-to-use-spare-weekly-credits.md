---
title: Scheduled runs to use spare weekly credits
status: backlog
author: Elijah Allen
created: 2026-10-19
tags:
  - agents
  - credits
depends_on:
  - agent-runner
  - agent-claim-and-lock-protocol
priority: 3
---

# Scheduled runs to use spare weekly credits

## Description

Spend usage that would otherwise expire, without getting in the way of interactive work. Design: [docs/agent-workflow.md](../../docs/agent-workflow.md) (Scheduling to use spare usage).

## Acceptance criteria

- [ ] `mdpm agent schedule install|uninstall|status` sets up the local runner with launchd (macOS), Task Scheduler (Windows) or cron/systemd (Linux), honouring `schedule.quietHours`, `weekends`, `weeklyReset` and `maxTasksPerRun`
- [ ] Spends harder in the last 24–48 hours before `weeklyReset`
- [ ] Optional `mdpm agent statusline` records Claude Code's `rate_limits` to `~/.mdpm/usage.json` and the scheduler uses it as a hint
- [ ] Documented setup for a Claude Code routine whose prompt uses the mdpm skill to work through the queue (requires `agent-claim-and-lock-protocol`)
- [ ] Note in the docs to check Anthropic's usage terms for unattended runs
