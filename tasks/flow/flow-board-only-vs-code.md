---
title: Flow board only VS Code
status: done
author: Elijah Allen
created: 2026-10-20
priority: 3
tags:
  - flow
  - vscode
approved: 2026-10-20
branch: flow/ai-flow-redesign
completed: 2026-10-20
---

# Flow board only VS Code

## Idea

Make the AI flow board the VS Code extension's only board. It has the columns Idea · Plan · Executing · Review · Done, stage-specific card actions (Approve, Answer & unblock, Accept, Rework), and a toolbar that shows the execution slot and what is waiting on the person. Remove the Kanban board, the waterfall, and the task-era commands. The spec is the *VS Code* section of [docs/agent-workflow.md](../../docs/agent-workflow.md).

## Context

- `packages/vscode/media/flow.js`, `board.js`, `waterfall.js`, `common.js`, `style.css`.
- `packages/vscode/src/panel.ts`, `model.ts`, `extension.ts`, `tree.ts` and `bulk.ts` (multi-select; keep it for Approve and Accept).
- `packages/vscode/package.json`: the commands `openBoard`, `openWaterfall`, `setStatus`, `setOwner`, `queueForAgent`, `unblock` and `sendToAgent*`.
- `packages/vscode/test/flow-webview.test.ts`.

## Acceptance criteria

- [x] *Open Board* opens the flow board. The Kanban and waterfall views, their commands, and their media files are deleted.
- [x] The columns are Idea, Plan, Executing, Review and Done. Plan cards show "awaiting approval" or "approved #n in queue". Blocked cards are yellow in their `blocked_from` column.
- [x] Card actions by stage: Idea → *Plan now*; Plan → **Approve** / *Re-plan*; Executing → *Continue with agent*; Blocked → **Answer & unblock** (opens the questions, then asks for an answer); Review → **Accept**, **Rework…** (asks for feedback), *Open PR*. Each action calls the matching `mdpm` command.
- [x] Dragging a card only allows the moves a person can make (for example plan → approved queue, review → done). An invalid drop shows why it was refused.
- [x] The toolbar shows the slot ("Executing: <idea> · 12m", "Blocked: <idea>" or "Slot free · N approved plans") and "Waiting on you: N".
- [x] The Projects tree groups ideas by stage inside each project. *New Task* becomes *New Idea*.
- [x] The extension README and the root README *VS Code extension* section are updated.

## Verification

- `npm run typecheck && npm test` (the webview tests cover the actions, the drop rules and the slot display)
- `npm run install-extension`, then open this repo and walk one idea through every stage by hand

## Constraints

- Keep the existing look (the colours, the yellow for blocked, the activity glow).

## Questions

## Log

- 2026-10-20 10:27 Elijah Allen — approved the plan
- 2026-10-20 10:27 claude — Approved on Elijah's instruction in chat (2026-10-20): 'can you just build it for me'.
- 2026-10-20 10:27 claude — started executing on branch idea/flow-board-only-vs-code
- 2026-10-20 10:27 claude — handed off for review: Flow board is the only board (Kanban, waterfall, bulk status/owner gone): stage actions, drag rules via core dropIntent, slot + waiting-on-you in the toolbar, Run next, multi-select Approve/Accept; tree groups ideas by stage; commands/menus/settings rewritten; READMEs updated. Verified: typecheck, webview tests (7). Not verified: the by-hand walkthrough in VS Code — please run npm run install-extension and try it.
