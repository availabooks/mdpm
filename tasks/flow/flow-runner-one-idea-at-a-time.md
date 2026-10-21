---
title: "Flow runner: one idea at a time"
status: done
author: Elijah Allen
created: 2026-10-20
priority: 2
tags:
  - flow
  - runner
approved: 2026-10-20
branch: flow/ai-flow-redesign
completed: 2026-10-20
---

# Flow runner: one idea at a time

## Idea

Make `mdpm agent run` follow the flow. It does one thing per run (plan an idea, or execute the idea in the slot or the top approved plan) in a single reused agent worktree, and `--until-idle` keeps going until nothing is left or usage runs out. The per-task worktrees and concurrency machinery go. The spec is the *Running* section of [docs/agent-workflow.md](../../docs/agent-workflow.md).

## Context

- `packages/core/src/runner.ts`: `runAgents`, `ensureWorktree`/`removeWorktree` (per task, under `.mdpm/worktrees/<id>`), `pushAndOpenPr`, `planContinue`/`runInteractive`, `REVIEW_REFINEMENT`, and the limit detection, which stays.
- `packages/core/src/activity.ts`: the active marker. It becomes the workspace-wide "one run at a time" lock.
- `packages/core/src/instructions.ts`: `buildPrompt`/`buildContinuePrompt` need the plan and execute modes. They now run in `.mdpm/agent/` on `idea/<id>`.
- CLI: the `agent run` and `agent continue` options in `packages/cli/src/index.ts`.

## Acceptance criteria

- [x] There is one worktree at `.mdpm/agent/`, created on first use and reused afterwards. No `.mdpm/worktrees/` is created. An old one is reported, with a hint on how to remove it.
- [x] Execute runs call `mdpm start` (unless resuming) and check out `idea/<id>`. The branch is created from the default branch on first use and reused on rework.
- [x] Plan runs use a detached checkout of the default branch. Uncommitted work in the worktree is first committed to its idea's branch as `wip: blocked on questions`.
- [x] A second `mdpm agent run` while one is active refuses, and says which idea is running and since when.
- [x] A plan run that ends without `propose`/`block` is blocked with a question. An execute run that ends without `handoff`/`block` stays `executing`, and the next run resumes it (`--resume <session>` for Claude).
- [x] `--until-idle` loops until `mdpm next` returns nothing or a usage limit is hit. `--max-tasks` is removed. `--idea <id>` runs one specific idea if it is eligible, and otherwise explains why not.
- [x] `mdpm agent continue <id>` opens an interactive session in `.mdpm/agent/` on the idea's branch, after the same wip-commit safety step.
- [x] Handoff still pushes and opens a PR with `gh` when it is available.
- [x] The README *Agents* section is updated.

## Verification

- `npm run typecheck && npm test`. Tests cover the worktree reuse, the wip commit before switching, the refusal of a second run, and the loop stopping when idle.
- `mdpm agent run --dry-run` on this repo prints the expected mode, idea, branch and prompt.

## Constraints

- Keep the agent presets, the stdin prompts, the live output, the run records and the limit detection unchanged.
- Never touch the person's checkout, except for idea files in `MDPM_ROOT`.

## Questions

## Log

- 2026-10-20 10:27 Elijah Allen — approved the plan
- 2026-10-20 10:27 claude — Approved on Elijah's instruction in chat (2026-10-20): 'can you just build it for me'.
- 2026-10-20 10:27 claude — started executing on branch idea/flow-runner-one-idea-at-a-time
- 2026-10-20 10:27 claude — handed off for review: runner.ts: one run at a time (activity marker as lock), one reused worktree .mdpm/agent, idea/<id> branches from the default branch, wip commit/stash before switching, plan runs detached on the default branch, --until-idle with stop rules, --idea, old worktrees reported; agent continue resumes the idea's last session (claude --resume) in the agent worktree. Verified with integration tests using a fake agent (plan then execute, blocked slot + wip commit + planning meanwhile, second run refused, no-plan block, resume, usage limit). Not verified: push/PR against a real remote (code path unchanged from before).
