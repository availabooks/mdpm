# Agent workflow — design

Status: **phases 1–2 implemented** (see the README's *Agents* section); phase 3 is in the backlog · Task: [`design-the-agent-workflow`](../tasks/agents/design-the-agent-workflow.md)

## Goal

Let coding agents (Claude Code first; Cursor, Codex and others through the same interface)
pick up tasks from an mdpm workspace and work on them **unattended**, so that subscription
usage that would otherwise expire each week turns into finished (or at least advanced) work.

A task is effectively a **queued prompt**. The person writes it the way they would write a
prompt to the agent, assigns it to the agent, and the agent works on it later "as if the
prompt came from them". When the agent is stuck, it doesn't guess. It writes its questions into
the task, marks it `blocked`, and moves on to the next one.

## Principles

1. **The task file is the conversation.** Everything the agent learns, decides, asks or
   finishes is written back to the task (front matter + body), so the person can catch up by
   reading one file, and the next agent run can resume from it.
2. **Agents change task state only through `mdpm` commands.** Those commands validate every
   write (see the README's *Validation* section), so an agent can't leave the board inconsistent.
   Agents may freely edit the task *body* (notes, plan, checkboxes).
3. **People approve, agents propose.** Agents never mark a task `done`; they hand off to
   `review`. Agents never push to the default branch; they work on a branch.
4. **Assigned work first.** An agent works on tasks assigned to it (`owner: claude`) first,
   then on unassigned tasks in projects that opt in (`agent.unassigned: true`).
5. **Agent-agnostic.** "Run an agent" is a configurable CLI command. Nothing in the protocol
   is Claude-specific; Claude-specific polish (a skill, usage-aware scheduling) sits on top.

## Lifecycle

```
             assign owner: claude                      person answers questions,
  backlog ──────────────────────▶ todo                 moves task back to todo
     │  (agent "refine" mode:       │ ▲                         │
     │   fills in description,      │ └─────────────────────────┤
     │   acceptance criteria)       ▼                           │
     └──────────────▶ todo ──▶ in-progress ──▶ blocked ─────────┘
                       (claim)      │           (questions written to the task)
                                    ▼
                                  review ──▶ done
                         (agent hands off;   (person only)
                          branch/PR linked)
```

### New `blocked` status

Default statuses become `backlog, todo, in-progress, blocked, review, done`. A status named
`blocked` gets special treatment:

- **Yellow** everywhere (board column and cards, tree icon, waterfall bars).
- Excluded from what agents pick.
- A task should carry at least one open question when blocked (validator rule
  `task/blocked-without-question`, warning).

Projects with custom `statuses` opt in by including `blocked` in their list.

## What an agent works on next: `mdpm next`

```bash
mdpm next --agent claude --json
```

Returns the single best task for that agent (or nothing), along with its **mode**:

| Task status | Mode | What the agent does |
|---|---|---|
| `in-progress`, owned by this agent | `resume` | Continue from the task's log (an earlier run was interrupted). |
| `todo` | `implement` | Do the work, verify the acceptance criteria, hand off to `review`. |
| `backlog` | `refine` | **No code changes.** Turn the idea into a ready task (context, acceptance criteria, verification steps, questions), then block it with its questions, so the person reviews the refinement before it is implemented. Refining is cheap and a good use of leftover usage. |
| `blocked`, `review`, `done` | — | Never picked. |

Eligibility, in order:

1. The project has agents enabled (`agent.enabled`, inherited; see *Configuration*).
2. `owner` is this agent's name, or the task is unassigned and the project sets
   `agent.unassigned: true`.
3. Every `depends_on` task is done.
4. The task has no validation errors.
5. For `implement`: the task is *ready* (has acceptance criteria). A task that isn't ready
   gets the `refine` mode instead. (Detailed in
   [`ready-for-agent-criteria-and-task-template`](../tasks/agents/ready-for-agent-criteria-and-task-template.md).)

Ranking: mode (`resume` → `implement` → `refine`), then assigned before unassigned, then
`priority`, then `end` (deadline), then `created`. Taking an unassigned task (`claim`)
sets its `owner` to the agent.

## How an agent writes back: task commands

All of these validate before writing, accept `--json`, and append a timestamped entry
signed with the agent's name to an `## Agent log` section at the end of the task body.

| Command | Effect |
|---|---|
| `mdpm claim <id>` | `status: in-progress`, `owner: <agent>`, `start:` (if unset), records the run id. Fails if another agent holds the claim. |
| `mdpm log <id> "<text>"` | Appends a log entry (progress, decisions, links). |
| `mdpm block <id> "<question>"…` | `status: blocked`, appends each question to a `## Questions` section as an open checkbox. |
| `mdpm handoff <id> "<summary>" [--branch b] [--pr url]` | `status: review`, records `branch:`/`pr:` in the front matter, logs the summary. |
| `mdpm release <id> "<reason>"` | Gives the task back (status `todo`, owner unchanged), for when the agent decides the task isn't one it should do. |

The agent's identity comes from `--agent` or the `MDPM_AGENT` environment variable (the
runner sets it). When `MDPM_AGENT` is set, the CLI also refuses to set `status: done` and refuses to
change tasks the agent hasn't claimed.

Example of a blocked task after a run:

```markdown
## Questions

- [ ] (claude, 2026-10-20) Should the export include archived tasks? The acceptance
      criteria say "all tasks" but archived ones have no status column.

## Agent log

- 2026-10-20 02:14 claude — claimed (run r-20261020-0214)
- 2026-10-20 02:31 claude — implemented CSV export on branch agent/export-csv; blocked on the question above
```

The person ticks or answers the question inline, then moves the task back to `todo`
(or clicks **Unblock** in VS Code), and the agent picks it up again on its next run.

## Teaching agents the protocol

`mdpm agent init` writes the instructions into the repo, in the formats agents read:

- **Claude Code skill**: `.claude/skills/mdpm/SKILL.md`. It explains the protocol above,
  the commands and the modes, and when to block instead of guessing.
- **`AGENTS.md`** section (read by Codex, Cursor and others), delimited by markers so
  re-running `init` updates it in place.

The runner also puts the essentials directly into each prompt, so a run works even without the
skill installed.

## Running agents: `mdpm agent run`

```bash
mdpm agent run                       # pick the next task for the default agent and run it
mdpm agent run --task export-csv     # run a specific task ("Send to agent")
mdpm agent run --agent codex --max-tasks 5
mdpm agent run --dry-run             # print the task and the prompt; don't run anything
```

For each task the runner:

1. Picks (`mdpm next`) and claims it (`mdpm claim`).
2. Creates or reuses a **git worktree** on branch `agent/<task-id>`, so the agent never
   touches the person's working copy, and runs can happen while they work.
3. Builds the prompt: protocol summary + mode instructions + the task file + paths.
4. Runs the agent command with `MDPM_AGENT`, `MDPM_TASK` and `MDPM_ROOT` set.
5. On handoff, pushes the branch and opens a PR with `gh pr create` when the GitHub CLI is
   available and logged in (otherwise the branch is left for the person to merge), and records `pr:`.
6. Afterwards: runs `mdpm check`. If the agent exited without handing off or blocking, logs
   that and leaves the task `in-progress`, so the next run resumes it.
7. Stops the loop when `--max-tasks` is reached, nothing is eligible, or the agent reports
   a usage limit (see *Scheduling*).
8. Records each run (agent, task, duration, exit code, usage if the agent reports it) in
   `.mdpm/runs/` (git-ignored).

**Where task-state edits go:** the runner and agent update the task file in the **main
checkout** (pointed to by `MDPM_ROOT`), not in the worktree. That way the board shows `in-progress`/`blocked`
live, while code changes stay on the agent's branch. *(Open question 1.)*

### Agent commands are configuration

Agents are defined as **argument lists** (no shell, so quoting works the same on Windows,
macOS and Linux) with placeholders. mdpm ships presets; a root `.proj` can override or add
agents:

```yaml
agents:
  default: claude
  claude:            # the built-in preset, shown for reference
    command: [claude, -p, "{prompt}", --output-format, json,
              --permission-mode, acceptEdits, --permission-prompts, none,
              --max-turns, "{maxTurns}", --allowedTools, "{allowedTools}"]
  codex:
    command: [codex, exec, "{prompt}"]
  cursor:
    command: [cursor-agent, -p, "{prompt}"]
  my-agent:
    command: [my-agent, --task-file, "{taskFile}", --cwd, "{worktree}"]
```

Placeholders: `{prompt}`, `{promptFile}` (for prompts too long for an argument),
`{taskFile}`, `{taskId}`, `{worktree}`, `{root}`, `{maxTurns}`, `{allowedTools}`.

Notes on the Claude preset (from the Claude Code docs, checked 2026-10-19):

- **No `--bare`.** It skips skills, `CLAUDE.md` and hooks, and only works with an API key,
  not subscription login. Plain `claude -p` uses the logged-in subscription.
- **Unattended permissions:** `acceptEdits` lets it edit files. `--permission-prompts none` makes
  any other permission request fail instead of waiting forever for a human. Shell commands
  the agent needs (`mdpm …`, `git …`, the project's test command) are granted per project
  with `agent.allowedTools`, e.g. `["Bash(mdpm *)", "Bash(git *)", "Bash(npm test)"]`.
- **Per-task limits:** `--max-turns` (default 50 in mdpm), so one task can't use up a
  whole usage window. `--max-budget-usd` exists but is a client-side estimate; mdpm can expose
  it as `agent.maxBudgetUsd` but doesn't rely on it.
- **Worktrees** are managed by mdpm (not `claude -w`), because the same mechanism has to work
  for every agent, and because headless runs don't clean up their worktrees.
- **Output:** `--output-format json` gives `result`, `session_id` and `total_cost_usd`;
  the runner stores these in the run record, and keeps `session_id` so a `resume` run can use
  `--resume <session_id>`.
- **Stop hook (optional, Claude only):** `mdpm agent init --claude-hook` adds a Stop hook
  that runs `mdpm check --task "$MDPM_TASK"` and blocks the agent from finishing while its
  task is invalid or still `in-progress` without a handoff/block/log entry.

## VS Code extension

- **Send to agent** (card hover button, task context menu, editor title): runs
  `mdpm agent run --task <id>` in an integrated terminal named `mdpm · claude · <id>`, so the
  run is visible and can be stopped. The default agent comes from the setting
  `mdpm.agent.default`; the dropdown next to the button (or a quick pick) chooses another.
  The extension runs its bundled copy of the CLI, so nothing needs to be on `PATH`.
- **Queue for agent**: sets `owner` to an agent without running it; the scheduled run will
  pick it up. This is the "line up prompts" action.
- **Unblock**: on blocked tasks; opens the questions, moves the task back to `todo`.
- Cards owned by an agent show a robot badge; blocked cards/columns are yellow.

## Scheduling to use spare usage

### What we can and can't know about usage

Pro/Max usage has a rolling **5-hour session window** and a **weekly limit** (shared across
models). Claude Code exposes the remaining amounts (`used_percentage` and `resets_at` for
both windows) only to the interactive **status line**. There's no documented way to read them from a
headless run or an API. So the scheduler can't ask "how much is left?". Instead it:

1. **Runs until limited.** The runner treats the limit message
   (`You've hit your session limit · resets 3:45pm`) as a normal end of the run, not a failure.
   It puts the task back (`in-progress`, resumable), records the reset time, and doesn't start
   another task before then. *(The exact exit code and output for a limit hit in `-p` mode
   isn't documented; we'll confirm it by testing before relying on it.)*
2. **Runs when the person isn't working**, so agent runs don't compete with interactive use:
   nights and weekends by default (`schedule.quietHours`).
3. **Spends harder before the weekly reset.** The person sets the weekly reset day and time
   once (`schedule.weeklyReset`, shown by `/usage`). In the last 24–48 hours before the reset,
   the runner uses every 5-hour window, because unused usage is about to expire. Earlier in the week it
   does one batch per night, leaving room for interactive work.
4. **Optionally records last-known usage.** `mdpm agent statusline` can be installed as (or
   wrap) the Claude Code status line command. Each time the person uses Claude Code
   interactively, it saves the `rate_limits` values to `~/.mdpm/usage.json`. The scheduler
   then skips nights when weekly usage is already near 100%, and goes harder when a lot is
   left close to the reset. This is last-known data, not live data, so it's used as a hint only.

### Where scheduled runs happen

| Option | Machine must be on | Sees the live board | Works for every agent | Notes |
|---|---|---|---|---|
| **A. Local runner** (`mdpm agent schedule install` → launchd on macOS, Task Scheduler on Windows, cron/systemd on Linux) | yes | yes (edits the local checkout) | yes | Uses the normal `claude` login. Simplest. **Recommended first.** |
| **B. Claude Code routines** (cloud, `/schedule`) | no | no: works from the default branch, pushes `claude/…` branches, opens PRs | Claude only | Uses subscription usage like interactive sessions; minimum interval 1 hour; research preview. Its prompt is just "use the mdpm skill to work through your queue". It needs git-based claims, because task-state changes travel through pushes/PRs. |
| **C. GitHub Actions** (`anthropics/claude-code-action` on a `schedule`, with a `claude setup-token` OAuth token) | no | no | Claude (others possible) | Same git-based model as B; scheduled workflows on public repos are disabled after 60 days without activity. |

Recommendation: build **A** in phase 3, designed so that **B** only needs the git-based claim
protocol on top. Both share the skill, the task commands and the run records.

Before running unattended at volume, check that it is consistent with Anthropic's usage
terms for your plan.

## Configuration summary (`.proj`)

```yaml
statuses: [backlog, todo, in-progress, blocked, review, done]
agent:
  enabled: true        # agents may work in this project (inherited)
  unassigned: false    # also pick tasks with no owner
  modes: [resume, implement, refine]   # which kinds of work agents may do here
  maxTurns: 50
  allowedTools: ["Bash(mdpm *)", "Bash(git *)", "Bash(npm test)"]
agents:                # (root .proj) agent definitions, see above
  default: claude
schedule:              # (root .proj) when the local runner may run
  quietHours: "22:00-07:00"
  weekends: true
  weeklyReset: "Mon 09:00"
  maxTasksPerRun: 5
```

## Decisions (2026-10-19)

1. **Which tasks agents pick:** both assigned and unassigned. Assigned tasks (`owner: <agent>`) come first;
   unassigned `todo`/`backlog` tasks are picked in projects with `agent.unassigned: true`.
2. **Git:** one worktree + branch `agent/<task-id>` per task, a PR on handoff. The person's
   working copy and the default branch are never touched by agent code changes.
3. **Scheduling:** phase 3 delivers both the local runner (option A) and Claude Code routines
   (option B), which means the git-based claim protocol is part of phase 3.
4. **Agents:** Claude (default), Cursor and Codex presets, plus custom commands.

Settled during implementation (2026-10-19):

- **Refinement claims keep the status.** `mdpm claim` on a `refine` task only sets `owner`, so
  a backlog idea doesn't show as in-progress while it is being written up.
- **Released tasks wait for the person.** `release` keeps the owner, so `mdpm next` skips a
  task whose latest log entry is the agent releasing it. Any later log entry (or reassigning
  it) puts it back in the queue; VS Code's *Queue for Agent* writes such an entry.
- **`mdpm` on the agent's PATH.** The runner writes small shims to `.mdpm/bin` that run the
  same CLI that started the run, so agents can call `mdpm` even when it isn't installed
  (e.g. when started from VS Code with the bundled CLI).
- **Prompt on stdin** for Claude and Codex, so long prompts and quotes never pass through a
  command line (on Windows, npm-installed `.cmd` programs are run via `cmd.exe` with every
  argument quoted).
- **Refinement always ends `blocked`.** The agent finishes a refine run with `mdpm block`; if it
  doesn't (or moves the task to `todo` itself), the runner blocks it with a "review the
  refinement" question. The person checks the task and unblocks it to have it implemented.
- **Live output.** The Claude preset uses `--output-format stream-json --verbose`; the runner
  prints each message and tool call as it happens and keeps the raw stream in the run log.
  The stream's `rate_limit_event` (`status`, `resetsAt`) is the primary usage-limit signal.
- **Continuing a conversation.** `mdpm agent continue <task>` runs the agent interactively in the
  task's worktree. Claude keeps sessions per working directory, so a worktree recreated at the same
  path (after a handoff removed it) can still reopen them; verified with `claude -p --resume <id>`
  and `--continue` against a removed and recreated worktree. It uses `--continue` rather than the
  run record's session id so that directions given in an earlier interactive session are kept too.
- **Verified `claude -p` flags** (Claude Code 2.1.303): `--permission-prompts none`,
  `--permission-mode acceptEdits`, `--max-turns`, `--add-dir`, `--allowedTools`,
  `--output-format json` (gives `session_id`, `total_cost_usd`, `subtype`/`terminal_reason`).

Still open:

- Task-state edits in the main checkout stay uncommitted until the person commits; should
  the runner auto-commit task-file-only changes? (Phase 1: no.)
- The exact output of a usage-limit hit in `claude -p` couldn't be reproduced on demand. The
  runner treats a `rate_limit_event` whose status isn't `allowed…` as the limit, and also
  recognizes the interactive wording (`You've hit your session limit · resets 3:45pm`)
  and the older `Claude AI usage limit reached|<epoch>` form in stdout, stderr and the JSON
  `result`; confirm against a real hit and adjust `LIMIT_PATTERNS` in
  `packages/core/src/runner.ts` if needed.

## Phasing → follow-up tasks

Each row is a task in `tasks/agents/`; `depends_on` encodes the order.

| Phase | Task | Depends on |
|---|---|---|
| 1 | [`blocked-status-in-all-views`](../tasks/agents/blocked-status-in-all-views.md) | this design |
| 1 | [`agent-task-commands`](../tasks/agents/agent-task-commands.md): `next`, `claim`, `log`, `block`, `handoff`, `release`, `MDPM_AGENT` guard rails | blocked status |
| 1 | [`ready-for-agent-criteria-and-task-template`](../tasks/agents/ready-for-agent-criteria-and-task-template.md) | this design |
| 1 | [`agent-init-skill-and-agents-md`](../tasks/agents/agent-init-skill-and-agents-md.md) | task commands |
| 2 | [`agent-runner`](../tasks/agents/agent-runner.md): `mdpm agent run`, presets, worktrees, PRs, run records | task commands, agent init |
| 2 | [`vs-code-agent-buttons`](../tasks/agents/vs-code-agent-buttons.md): Send to agent, Queue for agent, Unblock, badges | runner, blocked status |
| 3 | [`agent-claim-and-lock-protocol`](../tasks/agents/agent-claim-and-lock-protocol.md): git-based claims for cloud/multi-machine runs | task commands |
| 3 | [`scheduled-runs-to-use-spare-weekly-credits`](../tasks/agents/scheduled-runs-to-use-spare-weekly-credits.md): local scheduler + routines | runner, claim protocol |
