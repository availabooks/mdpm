---
title: Flow model, commands and migration
status: review
author: Elijah Allen
created: 2026-10-20
priority: 1
tags:
  - flow
  - core
  - cli
approved: 2026-10-20
branch: flow/ai-flow-redesign
---

# Flow model, commands and migration

## Idea

Make the AI flow the data model of mdpm, replacing tasks. The fixed statuses are idea → plan → executing → review → done, plus blocked. There is one execution slot, flow commands replace the task commands, and `mdpm migrate` moves a workspace over. After that, migrate this repo. Follow [docs/agent-workflow.md](../../docs/agent-workflow.md) exactly; it is the spec.

## Context

- `packages/core/src/types.ts`: `DEFAULT_STATUSES`, `AgentMode`, `AgentSettings`, `TASK_FIELDS`, `PROJECT_FIELDS`, `TaskMeta`, `Task`.
- `packages/core/src/flow.ts` is currently a *view* that maps old statuses to stages. It becomes the model: statuses, the slot rule, and queue order.
- `packages/core/src/agent.ts`: `agentQueue`, `modeFor`, `planClaim`/`planBlock`/`planHandoff`/`planRelease`, `agentGuard`. Rewrite these as flow write-backs: `propose`, `approve`, `start`, `block`, `unblock`, `handoff`, `rework`, `accept`, `log`.
- `packages/core/src/body.ts`: readiness becomes "plan complete". The templates become a single idea template (Idea, Plan, Acceptance criteria, Verification, Questions, Log).
- `packages/core/src/validate.ts`: drop the custom-status, `requiredByStatus` and depends_on rules. Add rules for the slot (more than one idea in the slot is an error), `blocked_from` (present and valid while blocked, absent otherwise), `approved` (only on plan, executing, review or done), and an incomplete plan that is approved.
- `packages/core/src/instructions.ts`: the protocol text used by the skill, AGENTS.md and prompts. Rewrite it for the plan and execute modes.
- `packages/cli/src/index.ts`: commands `new`, `set`, `move`, `next`, `claim`, `log`, `block`, `handoff`, `release`.
- The tests under `packages/core/test` and `packages/vscode/test` reference the old statuses.

## Acceptance criteria

- [x] Statuses are fixed as `idea, plan, executing, blocked, review, done`. A `statuses` key in `.proj` is reported as obsolete, with a fix hint to run `mdpm migrate`.
- [x] `owner`, `start`, `end`, `depends_on`, `required`, `requiredByStatus`, `agent.unassigned` and `agent.modes` are removed from types, validation and the CLI. `approved`, `blocked_from` and `completed` are added.
- [x] `mdpm next [--all] [--json]` returns `execute` (resume) → `execute` (top approved plan, only if the slot is free) → `plan` (top unblocked idea), in the documented queue order. `--all` explains every skip.
- [x] `mdpm idea`, `propose`, `approve`, `start`, `block`, `unblock`, `handoff`, `rework`, `accept` and `log` work as in the design's command table. `claim`, `release` and `new` are gone, and `mdpm new` prints "use mdpm idea".
- [x] `start` (and `move … executing`) refuses while the slot is taken. The error names the idea in the slot and how to free it.
- [x] The `MDPM_AGENT` guard rails work as designed. They are tested for each refused command.
- [x] `mdpm migrate` (dry run by default, `--write` to apply) applies the design's mapping table, renames the body sections, strips the removed fields and `.proj` keys, and regenerates the skill and AGENTS.md. It is tested on a fixture workspace with every old status.
- [x] This repo is migrated with `mdpm migrate --write`, `AGENTS.md` and the skill are regenerated, and `mdpm check --strict` passes.
- [x] The README sections *File format*, *CLI*, *Validation* and *Agents* describe the flow. No task vocabulary is left in user-facing text.

## Verification

- `npm run typecheck && npm test`
- `node packages/cli/dist/mdpm.js migrate` (dry run) on this repo shows the expected mapping, then `--write`, then `mdpm check --strict`
- By hand in a scratch workspace: `idea` → `next` (plan) → `propose` → `approve` → `start` → a second `start` is refused → `block` → `unblock` → `handoff` → `rework` → `accept`

## Constraints

- The runner (`runner.ts`) and the VS Code extension change in their own ideas. Keep them compiling by adapting call sites minimally. Don't redesign them here.
- Projects (`.proj` folders) and links stay.
- Every error says how to fix it.

## Questions

## Log

- 2026-10-20 10:00 claude — claimed (run r-20261020-100054-zu8m)
- 2026-10-20 10:27 claude — The aborted run above stopped right after claiming; built interactively with Elijah instead, on branch flow/ai-flow-redesign.
- 2026-10-20 10:27 claude — started executing on branch idea/flow-model-commands-and-migration
- 2026-10-20 10:27 claude — handed off for review: Flow model in packages/core/src/flow.ts (fixed statuses, execution slot, queue, propose/approve/start/block/unblock/handoff/rework/accept/move, drag rules, agent guard), validation rules for the flow and task-era leftovers, migrate.ts + mdpm migrate; CLI rewritten around the flow commands. This repo migrated (0 errors, 0 warnings with check --strict). Verified: npm run typecheck, npm test (92 passing), and the full flow by hand with the CLI in a scratch workspace.
