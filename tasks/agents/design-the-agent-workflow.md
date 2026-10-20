---
title: Design the agent workflow
status: done
author: Elijah Allen
created: 2026-10-19
priority: 1
tags:
  - agents
completed: 2026-10-19
---

# Design the agent workflow

## Idea

I want to make this project work with agents in the following way.

the agent on some sort of schedule, gets a task to work on. So i can use extra resources on my claude account without having to be there. 

Another way to think of this is lignin up several prompts that the agent can work with as if they are coming from me. These parts are key to work:



## Acceptance criteria

- [ ]**Our software must interface well with the agent, perhaps via a skill.** the agent must know what to work on next, this could be found by working on tasks that are either in the backlog, todo, in-progress, review, sections. agent should mark tasks as blocked and update task with questions, blockers or clarification it wants from the user. 
- [ ] We may need to add a "blocked" status for the agent to be able to mark in. Blocked tasks should be marked and made yellow on the UIs so they can easily be seen. 
- [ ] Our extension should have a button to "send to agent" which will will need to be configured, or selected. claude is the default we should include cursor, codex, muse code. I just see this as a cli call. 
- [ ] agents should know they can write to the task as well

## Design

Draft: [docs/agent-workflow.md](../../docs/agent-workflow.md). It covers the lifecycle and the
new `blocked` status, `mdpm next` (what to work on), the task write-back commands, the skill
and AGENTS.md, `mdpm agent run` with configurable agent CLIs, the VS Code buttons, scheduling
around usage limits, and the phased follow-up tasks.

## Log

- 2026-10-19 claude — claimed; researched Claude Code headless mode, routines, usage limits and hooks; wrote the draft design. Waited on the open questions.
- 2026-10-19 claude — recorded the decisions (assigned + unassigned queue, branch + PR, local runner and routines in phase 3, Claude/Cursor/Codex/custom agents); created 5 follow-up tasks and updated the 3 existing ones with descriptions, acceptance criteria and dependencies. Handing off for review of docs/agent-workflow.md.
