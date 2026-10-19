---
title: our UI should allow the user to select more than one task with ctrl/cmd click
status: todo
author: Elijah Allen
created: 2026-10-19
owner: claude
start: 2026-10-19
branch: agent/our-ui-should-allow-the-user-to-select-more-than-one-task-wi
pr: https://github.com/availabooks/mdpm/pull/1
---

# our UI should allow the user to select more than one task with ctrl/cmd click

## Description

The user may want to manage several tasks at once. Our UIs should let them multi-select tasks with ctrl/cmd click and then act on all selected tasks together.

## Goal

In the VS Code extension's three task UIs (Kanban board, Waterfall timeline, Projects tree), the user can select several tasks with Ctrl+click (Cmd+click on macOS) and change them all in one action: change status, change owner, and (on the board) drag them to another column together. A plain click works as it does now.

## Context

The extension lives in `packages/vscode`. It has no automated tests; core logic is tested in `packages/core/test`.

- `packages/vscode/media/common.js`: shared webview state (`mdpm.state`, persisted with `vscode.setState`), filtering, toolbar. Put the shared selection state and helpers here (for example `mdpm.selected: Set<key>`, `toggle`, `clear`, pruning keys that are no longer in `mdpm.filtered()` after each model update).
- `packages/vscode/media/board.js`: Kanban. In `wire()`, a card `click` posts `{type:'open'}`. The `dragstart` sets a single key in `dataTransfer`, and the column `drop` does an optimistic `task.status = status` followed by `post({type:'setStatus'})`. Cards are `.card[data-key]`, where `key` is the task's absolute file path.
- `packages/vscode/media/waterfall.js`: timeline. A label click (`.wf-label[data-key]`) opens the task. On a bar, `pointerdown`/`endDrag` opens the task if the pointer didn't move, and otherwise posts `setDates` for one task.
- `packages/vscode/media/style.css`: `.card` (around line 107) and `.wf-label` (around line 178) styles. Add a selected style using theme variables such as `--vscode-list-activeSelectionBackground` / `--vscode-focusBorder`.
- `packages/vscode/src/panel.ts`: the webview message handler (the `Message` union and `handle()`). On error it re-posts the model to revert optimistic changes.
- `packages/vscode/src/model.ts`: `Model.update(task, changes)` validates the change, shows a modal with **Save Anyway** on errors, writes, then calls `reload()`. Calling it in a loop would show one modal per task and reload N times.
- `packages/vscode/src/tree.ts` and `src/extension.ts`: the tree is registered with `registerTreeDataProvider('mdpm.projects', …)` (line 14), so it has no multi-select. `mdpm.setStatus`/`mdpm.setOwner` take a single `CommandArg` from `taskOf()`/`requireTask()`. VS Code passes `(clickedNode, selectedNodes[])` to context-menu commands when the view is created with `createTreeView(…, { canSelectMany: true })`.
- `packages/vscode/package.json`: `view/item/context` menus for `mdpm.setStatus`/`mdpm.setOwner` (`when: viewItem =~ /^task/`).

## Acceptance criteria

Selection (board and waterfall webviews):
- [ ] Ctrl+click (Windows/Linux) or Cmd+click (macOS) on a card or waterfall task label toggles that task in the selection and does **not** open the file. Check `e.ctrlKey || e.metaKey`.
- [ ] A plain click with no modifier clears the selection and opens the task, as it does today.
- [ ] Selected cards and labels have a visible selected style that works in light, dark and high-contrast themes.
- [ ] Pressing Escape, or clicking empty board/timeline space, clears the selection.
- [ ] The selection survives model refreshes (the file watcher re-render). Keys that no longer exist or are hidden by the current filters are dropped.
- [ ] When one or more tasks are selected, the toolbar shows "N selected" with **Set status…**, **Set owner…** and **Clear** controls. The controls are hidden when nothing is selected.

Bulk actions:
- [ ] Board: dragging a selected card moves **all** selected cards to the target column (optimistic update, then one message to the extension). Dragging an unselected card moves only that card, as it does today.
- [ ] Toolbar **Set status…** and **Set owner…** send one bulk message (for example `{type:'setStatusMany', files, status}` / `{type:'setOwnerMany', files, owner}`) to `panel.ts`, which shows a VS Code quick pick or input box and applies the change. Offer only the statuses valid for every selected task's project; if there are none in common, show an error message that says so and suggests narrowing the selection.
- [ ] Tree: the Projects view is created with `vscode.window.createTreeView('mdpm.projects', { treeDataProvider, canSelectMany: true })`. Running **Set Status** / **Set Owner** from the context menu with several tasks selected applies to all of them (use the second `selectedNodes` argument; ignore project nodes in it).
- [ ] Bulk changes are validated up front: one modal lists every task whose change would be invalid, with **Save Anyway** / **Skip Invalid** choices. After writing, the model reloads once (not once per task). Add a `Model.updateMany` or similar for this, rather than calling `update()` in a loop.
- [ ] If any write fails, the error message names the tasks that were not saved and says how to retry, and the view reverts to what is on disk. This follows the actionable-error convention already used in `panel.ts`.

Waterfall:
- [ ] Dragging (moving) a bar whose task is selected shifts every selected **scheduled** task by the same number of days, sent as one bulk `setDates` message. Resize handles (`h-start`/`h-end`) still resize only the bar being dragged.

Docs:
- [x] `packages/vscode/README.md` documents multi-select (Ctrl/Cmd+click) and the bulk actions.

> Agent note (2026-10-19): every criterion above is implemented on branch
> `agent/our-ui-should-allow-the-user-to-select-more-than-one-task-wi` (commit 6de82a3), but only the
> README one is ticked. In this unattended run the sandbox denied every `npm`/`node` command, so
> typecheck, tests, build, `mdpm check --strict` and the manual F5 checks were **not run**. Run the
> Verification section, then tick the rest.

## Verification

```bash
npm run typecheck
npm test
npm run build
node packages/cli/dist/mdpm.js check --strict
```

Manual check: press F5 with the `.vscode/launch.json` config, or `npm run install-extension`. In a workspace with a few tasks:
1. Board: Cmd/Ctrl+click 3 cards, check that they are highlighted and the toolbar shows "3 selected". Drag one of them to another column and confirm all 3 files' `status:` changed. Plain-click a card and confirm it opens and the selection clears.
2. Board: select 2 tasks, run **Set owner…**, enter a name, and confirm both files have `owner:` set and the board refreshed once.
3. Waterfall: select 2 scheduled tasks, drag one bar 3 days right, and confirm both tasks' `start`/`end` shifted by 3 days.
4. Projects tree: Cmd/Ctrl+click 2 tasks, right-click, **Set Status**, and confirm both changed.
5. Make a bulk change that is invalid for one task. Confirm a single modal lists it, and that **Skip Invalid** saves the others.

## Constraints

- Change only `packages/vscode`, plus `packages/core` if a shared helper is truly needed (for example a bulk update, with tests in `packages/core/test`). The CLI is out of scope.
- Use plain JS in `media/*.js`, matching the existing style: no frameworks, no new dependencies.
- Don't change single-task behavior: a plain click opens, a single-card drag sets status, and bar drag/resize works as before.
- Shift+click range selection, bulk delete, and bulk link/unlink are out of scope.
- Keep every error message actionable: say what went wrong and how to fix it.

## Agent log

- 2026-10-19 10:35 claude — claimed for refinement (run r-20261019-103504-vsby)
- 2026-10-19 10:36 claude — Refined: scoped multi-select (Ctrl/Cmd+click) to Kanban, Waterfall and Projects tree; bulk set status/owner, multi-card drag, multi-bar shift; single validation modal + one reload; shift-range/bulk delete out of scope. Added context, criteria, verification, constraints.
- 2026-10-19 10:36 claude — claimed (run r-20261019-103636-18uv)
- 2026-10-19 10:41 claude — Implemented on branch (commit 6de82a3): shared selection in media/common.js, board multi-drag, waterfall group shift, toolbar bulk controls, src/bulk.ts (setStatus/setOwner prompts), Model.updateMany (one validation modal, one reload, Retry on failed writes), tree createTreeView canSelectMany, README. Could NOT run verification: npm/node commands were denied by the sandbox in this unattended run.
- 2026-10-19 10:42 claude — handed off for review: Multi-select (Ctrl/Cmd+click) for board, waterfall and Projects tree, with bulk set status/owner, multi-card drag, group bar shift, and Model.updateMany (one validation modal with Save Anyway / Skip Invalid, one reload, Retry for failed writes). NOT VERIFIED: the sandbox denied npm/node, so typecheck/test/build/check and the manual checks still need to be run. Only the README criterion is ticked.
- 2026-10-19 10:42 mdpm — run r-20261019-103636-18uv: opened https://github.com/availabooks/mdpm/pull/1
