# AI flow — design

Status: **implemented 2026-10-20** (see the README). This replaces the task-based agent
workflow (phases 1–2, shipped 2026-10-19). That design is in git history at `8a5f188`.
The work was done as the ideas in [`tasks/flow/`](../tasks/flow/); see *Build order* below.

## Why

The task-based workflow treated agents as workers pulling from a backlog: owners, claims,
per-task worktrees, several runs at once. That isn't how we want to work with AI. What we
want is a **flow**: you have an idea, the agent turns it into a plan, you approve the plan,
the agent builds it, and you review it. The agent works through that flow **one idea at a
time** in the background, using spare subscription usage.

Speed is not a goal. The agent doesn't need to be fast or work in parallel. It needs to keep
turning approved plans into reviewable work, and ideas into plans, whenever there is spare
usage.

## The flow

```
idea ──▶ plan ──▶ executing ──▶ review ──▶ done
 you     agent drafts,  agent,       you        you
         you approve    one at a time
  ▲         ▲              ▲
  └─────────┴──────────────┴── blocked (waiting for your answer; returns to where it came from)
```

| Status | Who acts | Meaning |
|---|---|---|
| `idea` | you write it | What you want built, in your own words. The agent may plan it. |
| `plan` | agent drafts, you approve | The agent has written a plan. It waits for you until you **approve** it (`approved:` is set). |
| `executing` | agent | The agent is building it on the idea's branch. **At most one idea is executing in the workspace.** |
| `blocked` | you answer | The agent has questions (`## Questions`). `blocked_from:` records where it goes back to. |
| `review` | you check | The work is on a branch (and a PR, when `gh` is set up). |
| `done` | you | Accepted. Only a person moves an idea to done. |

These six statuses are fixed. `.proj` files no longer define `statuses`.

### One idea at a time

There is a single **execution slot**. It's taken by the idea that is `executing`, or by one
that is `blocked` with `blocked_from: executing`. While the slot is taken, no other idea
starts executing. This holds even when the idea in the slot is blocked. The agent may still
**plan** other ideas while it waits for your answer, because planning doesn't change code.

Only one agent run happens at a time across the workspace, whether it's planning or
executing. The existing activity marker (`.mdpm/active/`) is the lock.

## An idea file

```markdown
---
title: Export the board as CSV
status: plan
created: 2026-10-20
priority: 2
approved: 2026-10-21        # set by `mdpm approve`; absent = plan waiting for you
blocked_from: executing     # only while blocked
branch: idea/export-the-board-as-csv
pr: https://github.com/…
completed: 2026-10-23       # set when moved to done
tags: [export]
---

# Export the board as CSV

## Idea
What you want, in your own words. This is the only part you have to write.

## Plan
The agent's approach: what it will change, where, and in which order.

## Acceptance criteria
- [ ] …

## Verification
Commands or checks that prove it works.

## Questions
- [ ] (claude, 2026-10-20) …

## Log
- 2026-10-20 02:14 claude — planned: …
```

- **Front matter fields:** `title`, `status`, `created`, `priority`, `tags`, `approved`,
  `blocked_from`, `branch`, `pr`, `completed`, plus `id` and `author`. These are removed:
  `owner` (there is one agent and one flow), `start`/`end` (and with them the waterfall view),
  and `depends_on` (order comes from the queue).
- **A plan is complete** when `## Acceptance criteria` has at least one `- [ ] …` item. This
  is the same readiness rule as before. `mdpm approve` refuses an incomplete plan, and warns
  about open questions.
- `## Agent log` becomes `## Log`, and `## Description`/`## Goal` become `## Idea`.
- Projects (`.proj` folders) and links between them stay. They group ideas; they aren't part
  of the flow. These `.proj` keys go: `statuses`, `required`, `requiredByStatus`, and
  `agent.unassigned`/`agent.modes`.

## What the agent does next: `mdpm next`

`mdpm next [--json]` returns at most one idea and the **mode** to work on it:

1. **`execute` (resume):** an idea is `executing`. Continue it.
2. If the slot is taken by a blocked idea, skip step 3.
3. **`execute`:** the approved plan at the top of the queue (an approved `plan`).
4. **`plan`:** the top `idea` that isn't blocked.
5. Nothing: everything is waiting on you.

Queue order is ideas sent back from review first (see `mdpm rework`), then `priority`, then
`approved` date (for plans) or `created` date (for ideas). `mdpm next --all` lists the whole
queue and says why each skipped idea was skipped.

| Mode | The agent… | Ends with |
|---|---|---|
| `plan` | reads the code, changes none of it, writes Plan, Acceptance criteria, Verification and any Questions | `mdpm propose` → `plan` (waiting for approval), or `mdpm block` if it can't plan without an answer |
| `execute` | works on the idea's branch, ticks the criteria, runs the verification | `mdpm handoff` → `review`, or `mdpm block` |

## Commands

The agent's name comes from `$MDPM_AGENT` or `--agent`. It's only used to sign log entries.
All commands validate before writing, accept `--json`, and add a signed, timestamped line to
`## Log`.

| Command | Who | Effect |
|---|---|---|
| `mdpm idea <title…>` | you | Creates an idea from the template (replaces `mdpm new`). |
| `mdpm propose <id> "<summary>"` | agent | `idea` → `plan`. The plan is drafted and waits for approval. |
| `mdpm approve <id>` | you | Sets `approved:`, which puts the plan in the execution queue. |
| `mdpm start <id>` | agent/runner | Approved `plan` → `executing`, sets `branch:`. Refuses while the slot is taken. |
| `mdpm block <id> "<q>"…` | agent | → `blocked` with `blocked_from:`. Each question goes under `## Questions`. |
| `mdpm unblock <id> ["<answer>"]` | you | Back to `blocked_from`, and logs the answer. |
| `mdpm handoff <id> "<summary>" [--pr url]` | agent | `executing` → `review`. |
| `mdpm rework <id> "<feedback>"` | you | `review` → approved `plan`, at the front of the queue, on the same branch. |
| `mdpm accept <id>` | you | `review` → `done`, sets `completed:`. |
| `mdpm log <id> "<text>"` | anyone | Adds a log entry. |
| `mdpm move <id> <status>` | you | A manual escape hatch. It still enforces the slot rule. |

`claim`, `release`, `set owner=…` and the readiness/refine modes are removed.

**Guard rails while `MDPM_AGENT` is set:** the agent can't `approve`, `accept`, `rework`,
`unblock` or `move`. It can't start executing an unapproved plan. It can only change the
idea that the current run is about (`$MDPM_TASK`).

## Running: `mdpm agent run`

```bash
mdpm agent run              # do the next thing (one plan or one execute run)
mdpm agent run --until-idle # keep going until nothing is left or usage runs out
mdpm agent run --idea <id>  # plan or execute this idea now (it must be next-eligible)
mdpm agent run --dry-run
```

- **One worktree:** `.mdpm/agent/` is reused for every run. It keeps the agent out of your
  checkout. It isn't there for concurrency. There are no per-idea worktrees.
- **Execute runs** check out `idea/<id>` in that worktree. The branch is created from the
  default branch the first time, and kept on rework.
- **Plan runs** use a detached checkout of the latest default branch in the same worktree. If
  the worktree has uncommitted changes from a blocked execution, the runner first commits them
  to that idea's branch as `wip: blocked on questions`, so switching never loses work.
- **Idea files are edited in the main checkout** (`MDPM_ROOT`), so the board updates live.
  This is the same as today.
- **After a run:** the runner checks the idea. A plan run that ends without `propose` or
  `block` gets blocked with "the plan run ended without a plan". An execute run that ends
  without `handoff` or `block` stays `executing`, so the next run resumes it (Claude resumes
  its session).
- **On handoff:** the runner pushes the branch and opens a PR with `gh` if it is available.
- **Usage limits** end the loop, the same as today (`rate_limit_event`, limit messages).
- `mdpm agent continue <id>` still opens an interactive session in the agent worktree,
  checked out on the idea's branch.
- Agent presets (`claude`, `codex`, `cursor`, custom commands), stdin prompts, live output,
  run records and the activity marker all stay as they are.

## Using spare usage

This doesn't change from the earlier design, but it gets simpler: a scheduled run is just
`mdpm agent run --until-idle` during quiet hours. Every run is useful, because when there's
nothing to execute, it plans. See
[`scheduled-runs-to-use-spare-weekly-credits`](../tasks/agents/scheduled-runs-to-use-spare-weekly-credits.md).
Cloud runs (Claude Code routines) and the git-based claim protocol are dropped. They only
existed to coordinate several agents.

## VS Code

- The **flow board** is the only board. It has the columns Idea · Plan · Executing ·
  Review · Done, and blocked cards stay yellow in the column they came from.
- **Card actions** depend on the stage:
  - Idea: *Plan now*.
  - Plan: **Approve** (or *Re-plan*).
  - Executing: *Continue with agent*.
  - Blocked: **Answer & unblock**.
  - Review: **Accept**, **Rework…**, *Open PR*.
- The **execution slot** is shown in the toolbar, for example "Executing: export-csv · 12m"
  or "Slot free · 3 approved plans waiting". Next to it is a **"Waiting on you: N"** count.
- **Removed:** the Kanban board, the waterfall timeline, *Set Status…*, *Set Owner…* and
  *Queue for Agent…*.
- The **Projects tree** groups ideas by stage inside each project.

## Migration: `mdpm migrate`

This is a one-time rewrite of a workspace. It's a dry run by default; `--write` applies it.
Status mapping:

| Old | New |
|---|---|
| `backlog` | `idea` (it was never refined, so the agent plans it) |
| `todo` with criteria, without an agent owner | `plan`, unapproved |
| `todo` without criteria | `idea` |
| `todo` owned by an agent | `plan`, approved |
| `in-progress` | `executing`. If there are several, the oldest one; the rest become approved `plan`, and the report lists them. |
| `blocked` | `blocked`, with `blocked_from` = `executing` if `start` was set, else `plan` if it had criteria, else `idea` |
| `review` / `done` | `review` / `done` (`end` → `completed`) |

Migration also renames the body sections (`Description`/`Goal` → `Idea`, `Agent log` → `Log`),
drops `owner`/`start`/`end`/`depends_on`, removes the obsolete `.proj` keys, and regenerates
the skill and AGENTS.md section. Unknown statuses are reported, not guessed.

## Decisions (2026-10-20)

1. **One idea executing at a time.** A blocked execution keeps the slot. Planning can continue
   while the slot is taken.
2. **One reused agent worktree** (`.mdpm/agent/`) and a branch per idea (`idea/<id>`).
3. **Plan approval** is a separate action (`mdpm approve`, and **Approve** in VS Code), so
   "plan drafted" and "plan approved" are distinct.
4. **Clean break:** fixed statuses, the task vocabulary removed, and old workspaces moved
   over with `mdpm migrate`.

## Build order

| # | Idea | Depends on |
|---|---|---|
| 1 | [`flow-model-commands-and-migration`](../tasks/flow/flow-model-commands-and-migration.md) | this design |
| 2 | [`flow-runner-one-idea-at-a-time`](../tasks/flow/flow-runner-one-idea-at-a-time.md) | 1 |
| 3 | [`flow-board-only-vs-code`](../tasks/flow/flow-board-only-vs-code.md) | 1 (2 for the slot display) |
| 4 | [`scheduled-runs-to-use-spare-weekly-credits`](../tasks/agents/scheduled-runs-to-use-spare-weekly-credits.md), rewritten for the flow | 2 |

#1–#3 were built together on branch `flow/ai-flow-redesign`, and this repo was migrated with
`mdpm migrate --write`. #4 waits in the plan queue for approval.

Settled during implementation (2026-10-20):

- **Reopening a conversation** uses the session id of the agent's last run on the idea
  (`claude --resume <id>`) instead of `--continue`: every idea shares the agent worktree, so
  "the latest conversation in this directory" could belong to another idea.
- **A plan run that wrote a complete plan but didn't propose** is proposed by the runner (the
  person reviews it either way); one that wrote no plan is blocked with a question.
- **After handoff** the agent worktree detaches, so the person can check the idea's branch out
  to review it.
- **`--until-idle`** stops early when a run ends without writing anything back, and runs one
  idea at most three times per loop, so a stuck idea can't use up the week's usage.
- **`mdpm migrate`** regenerates the skill and AGENTS.md only where `mdpm agent init` wrote
  them before; a blocked task whose only open question was "review the refinement" becomes a
  plan waiting for approval.
