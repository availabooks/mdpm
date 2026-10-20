---
title: "Flow runner: one idea at a time"
status: todo
author: Elijah Allen
created: 2026-10-20
priority: 2
tags:
  - flow
  - runner
depends_on:
  - flow-model-commands-and-migration
---

# Flow runner: one idea at a time

## Goal

Make `mdpm agent run` follow the flow. It does one thing per run (plan an idea, or execute the idea in the slot or the top approved plan) in a single reused agent worktree, and `--until-idle` keeps going until nothing is left or usage runs out. The per-task worktrees and concurrency machinery go. The spec is the *Running* section of [docs/agent-workflow.md](../../docs/agent-workflow.md).

## Context

- `packages/core/src/runner.ts`: `runAgents`, `ensureWorktree`/`removeWorktree` (per task, under `.mdpm/worktrees/<id>`), `pushAndOpenPr`, `planContinue`/`runInteractive`, `REVIEW_REFINEMENT`, and the limit detection, which stays.
- `packages/core/src/activity.ts`: the active marker. It becomes the workspace-wide "one run at a time" lock.
- `packages/core/src/instructions.ts`: `buildPrompt`/`buildContinuePrompt` need the plan and execute modes. They now run in `.mdpm/agent/` on `idea/<id>`.
- CLI: the `agent run` and `agent continue` options in `packages/cli/src/index.ts`.

## Acceptance criteria

- [ ] There is one worktree at `.mdpm/agent/`, created on first use and reused afterwards. No `.mdpm/worktrees/` is created. An old one is reported, with a hint on how to remove it.
- [ ] Execute runs call `mdpm start` (unless resuming) and check out `idea/<id>`. The branch is created from the default branch on first use and reused on rework.
- [ ] Plan runs use a detached checkout of the default branch. Uncommitted work in the worktree is first committed to its idea's branch as `wip: blocked on questions`.
- [ ] A second `mdpm agent run` while one is active refuses, and says which idea is running and since when.
- [ ] A plan run that ends without `propose`/`block` is blocked with a question. An execute run that ends without `handoff`/`block` stays `executing`, and the next run resumes it (`--resume <session>` for Claude).
- [ ] `--until-idle` loops until `mdpm next` returns nothing or a usage limit is hit. `--max-tasks` is removed. `--idea <id>` runs one specific idea if it is eligible, and otherwise explains why not.
- [ ] `mdpm agent continue <id>` opens an interactive session in `.mdpm/agent/` on the idea's branch, after the same wip-commit safety step.
- [ ] Handoff still pushes and opens a PR with `gh` when it is available.
- [ ] The README *Agents* section is updated.

## Verification

- `npm run typecheck && npm test`. Tests cover the worktree reuse, the wip commit before switching, the refusal of a second run, and the loop stopping when idle.
- `mdpm agent run --dry-run` on this repo prints the expected mode, idea, branch and prompt.

## Constraints

- Keep the agent presets, the stdin prompts, the live output, the run records and the limit detection unchanged.
- Never touch the person's checkout, except for idea files in `MDPM_ROOT`.

## Questions
