---
title: New Kanban UI
status: done
author: Elijah Allen
created: 2026-10-19
branch: agent/new-kanban-ui
pr: https://github.com/availabooks/mdpm/pull/2
completed: 2026-10-19
---

# New Kanban UI

## Idea

Build a kanban UI for how we actually work with AI, not how people used to work in teams of people

## Context

The kanban UI is part of the UI that is built into our extension for mdpm. Currently it has a tradditional UI but i want to change that. 

## Acceptance criteria

- [x] The new flow is Idea (where the user rights what they want to build, this is the first step) -> Planned (the agent creates a plan based off of the idea, aka task) -> building (the agent is now executing the actual coding) -> Review (the users job to review to work) -> Done (the idea has now been turned into product)

## Verification

Write tests that ensure the code works

## Constraints

For now, do not remove the current kanban board, make this a new option

## Questions

## Log

- 2026-10-19 13:39 claude — claimed (run r-20261019-133942-55y5)
- 2026-10-19 13:44 claude — Added 'mdpm: Open AI Flow Board' (new view; classic Kanban untouched). Lanes map onto existing statuses so the CLI/agent workflow is unchanged: Idea=backlog, Planned=todo, Building=in-progress, Review=review, Done=final status. blocked stays in the lane it came from (Building if start is set, else Planned if it has criteria, else Idea), flagged 'Needs your answer'. Verification: npm test (50 pass, incl. 11 core flow tests + 5 webview tests run in a fake DOM), npm run typecheck, npm run build all pass. Not tried by hand in a running VS Code.
- 2026-10-19 13:44 claude — handed off for review: New 'AI Flow' board (mdpm: Open AI Flow Board, also in the Projects view toolbar and project context menu) with lanes Idea → Planned → Building → Review → Done; classic Kanban kept. Lanes are a view over the existing statuses (packages/core/src/flow.ts), so nothing else changes. Decision for you to check: I mapped stages to statuses instead of adding new statuses; a Planned card with no acceptance criteria shows 'no plan yet'. Tests: npm test passes 50 tests, typecheck and build pass. Not tried by hand in VS Code.
- 2026-10-19 13:44 mdpm — run r-20261019-133942-55y5: opened https://github.com/availabooks/mdpm/pull/2
