# mdpm — markdown project management that lives in your repo

Tasks are markdown files. Projects are folders. Everything is plain text in git, so humans,
VS Code, and AI agents (Claude, Cursor, …) can all read and update the same backlog.

Website and support: <https://mdpm.availabooks.com>

```
tasks/                        ← a project (has a .proj file)
├── .proj
├── website/                  ← a sub project
│   ├── .proj
│   ├── design-landing-page.md
│   └── auth/                 ← a sub-sub project
│       ├── .proj
│       └── oauth-login.md
└── mobile/
    ├── .proj
    └── oauth-login.md -> ../website/auth/oauth-login.md   ← shared task (symlink)
```

It works on its own repo or embedded inside a code repo (e.g. a `tasks/` folder next to `src/`).

## File format

### Projects: `.proj`

Any folder containing a `.proj` file is a project. A project folder inside another one is a
sub project. Folders *without* a `.proj` inside a project are just organisation; their tasks
belong to the nearest project above them.

```yaml
name: Website
description: Marketing site and customer portal
owner: eli
statuses: [backlog, todo, in-progress, blocked, review, done]   # Kanban columns, in order
taskExtension: .md        # or .task — extension for new tasks
ignore: [assets]          # folder names to skip while scanning
required: [owner]         # fields every task must have
requiredByStatus:         # extra fields a task needs before it may enter a status
  in-progress: [owner, start]
  done: [end]
agent:                    # what coding agents may do here (see Agents)
  unassigned: true
# any other keys are kept and passed through
```

`statuses`, `taskExtension`, `required`, `requiredByStatus` and `agent` are inherited by sub
projects that don't set their own. The
default statuses are `backlog, todo, in-progress, blocked, review, done`. A status named
`blocked` means the task is waiting for an answer: it is yellow on the board, in the tree and
on the waterfall, agents never pick it, and it should have an open question under
`## Questions`. Projects with their own `statuses` opt in by listing `blocked`. The **last** status is
treated as "done" (for overdue highlighting and the waterfall view). Moving a task to it, from
the CLI or VS Code, sets `end` to today if the task doesn't have an end date yet. Likewise,
moving a task to `in-progress` (or a later status such as `blocked` or `review`) sets `start`
to today if it has no start date. Dates you set yourself are never overwritten.

### Tasks: `*.md` or `*.task`

A task is a `.md` or `.task` file inside a project that **starts with a YAML front matter
block**. Markdown files without front matter (READMEs, notes) are ignored.

```markdown
---
title: OAuth login
status: in-progress
owner: eli
author: Elijah Allen
created: 2026-10-19
start: 2026-10-25        # YYYY-MM-DD
end: 2026-10-30
priority: 1              # number, or high / medium / low
tags: [auth, backend]
depends_on: [design-landing-page]   # task ids
---

# OAuth login

Free-form markdown: description, acceptance criteria, notes, links…
```

| Field        | Meaning |
|--------------|---------|
| `id`         | Optional. Defaults to the file name without extension. Must be unique. |
| `title`      | Defaults to the first `# heading`, then the file name. |
| `status`     | One of the project's `statuses`. Defaults to the first one. |
| `owner`      | Who is doing it. |
| `author`     | Who wrote it. |
| `created`, `start`, `end` | `YYYY-MM-DD`. `start`/`end` drive the waterfall view. |
| `priority`   | Number (lower = more urgent) or a word. |
| `tags`       | List of strings. |
| `depends_on` | List of task ids; drawn as arrows in the waterfall view. |
| `branch`, `pr` | Where the work is. Set by `mdpm handoff` and the agent runner. |

Any other keys are preserved untouched, so you can add your own fields.

### Sharing a task between projects

Don't copy the task; symlink it. `mdpm link <task> <project>` (or *Add to Another
Project* in VS Code) creates a relative symlink. The task is counted once, edited in one
place, and appears in every project that links to it.

**Windows:** creating symlinks needs Developer Mode (or admin), and git needs
`git config core.symlinks true` to check them out as real links. If symlinks aren't
available, git writes a one-line text file containing the relative path instead. mdpm
recognises these *stub files* and treats them exactly like symlinks, and falls back to
writing one itself when it can't create a symlink. A repo therefore works the same on
Windows, macOS and Linux either way.

## CLI

```bash
npm install && npm run build
npm link -w @mdpm/cli          # puts `mdpm` on your PATH (or: node packages/cli/dist/mdpm.js)
```

```bash
mdpm init tasks -n "My Product"         # root project in ./tasks
mdpm project tasks/website              # sub project
mdpm new "Design landing page" -p website -o eli --start 2026-10-20 --end 2026-10-24 -t ui
mdpm new "Export CSV" -o claude --template agent   # body with Goal, Context, Acceptance criteria, Verification…
mdpm list -s todo,in-progress -o eli    # filter; add --json for machine-readable output
mdpm show design-landing-page           # by id or path
mdpm move design-landing-page in-progress
mdpm set design-landing-page owner=sam tags=ui,marketing priority=2 end=   # empty value deletes
mdpm link oauth-login mobile            # share a task with another project
mdpm unlink oauth-login mobile
mdpm board -p website                   # text kanban
mdpm projects
mdpm check                              # validate everything (exit code 1 on errors)
mdpm check --strict --json              # warnings fail too; machine-readable report
```

`new`, `set` and `move` validate the result **before** writing. If the change would break a
rule, nothing is written, the problems are printed with their rule codes, and the exit code is 1.
Add `--force` to write anyway.

For agents: `mdpm next`, `claim`, `log`, `block`, `handoff`, `release` and `agent init/run`
(see [Agents](#agents)).

The root is found automatically: `--root`, else `$MDPM_ROOT`, else the enclosing git repo,
else the topmost folder with a `.proj`. Projects are referenced by folder path relative to
the root (`tasks/website`) or by unique name (`website`). `list`, `show`, `projects`, `new`,
`check`, `next` and the agent write-back commands accept `--json`; `check --task <id>` checks one task.

## Validation

Because agents (and people) edit tasks unattended, mdpm checks every `.proj` and every
task's front matter. Problems come with a stable **rule code**, the **line** they're on, and
a message that says how to fix them. You'll see them in:

- `mdpm check`, for CI and agents. `--strict` makes warnings fail too, and `--json` prints a report with `ok`, counts and each issue's `code`, `file`, `line`, `field` and `message`.
- every write: `mdpm new/set/move` and the VS Code board, tree and waterfall refuse changes that would introduce an error (VS Code offers *Save Anyway*). Problems the task already had never block an unrelated change.
- the VS Code Problems panel, underlined on the offending line.

| Code | Level | Meaning |
|------|-------|---------|
| `proj/yaml-invalid` | error | `.proj` isn't valid YAML, or isn't `key: value` lines |
| `proj/field-type` | error | a setting has the wrong type (e.g. `statuses: todo` instead of a list) |
| `proj/field-value` | error/warn | `taskExtension` isn't `.md`/`.task`; `ignore` contains paths or globs |
| `proj/statuses-empty` | error | `statuses: []` |
| `proj/statuses-duplicate` | error | a status is listed twice |
| `proj/required-unknown-status` | error | `requiredByStatus` names a status the project doesn't have |
| `proj/unknown-field` | error/warn | likely typo of a setting (error if the intended setting is therefore missing) |
| `proj/agent-unknown` | error | `agents.default` names an agent that isn't defined |
| `proj/agents-not-root` | warning | `agents` is set in a sub project's `.proj`, where it is ignored |
| `task/yaml-invalid` | error | front matter isn't valid YAML, or isn't `key: value` lines |
| `task/field-type` | error | e.g. `status: [todo]`, `tags: {a: 1}` |
| `task/status-unknown` | error | `status` isn't one of the project's `statuses` |
| `task/date-invalid` | error | `created`/`start`/`end` isn't a real `YYYY-MM-DD` date |
| `task/date-order` | error | `end` is before `start` |
| `task/required-missing` | error | a field required by `required` / `requiredByStatus` is missing |
| `task/duplicate-id` | error | two tasks share an id |
| `task/dependency-unknown` | error | `depends_on` names a task that doesn't exist |
| `task/dependency-self` | error | a task depends on itself |
| `task/dependency-cycle` | error | `depends_on` forms a loop |
| `task/dependency-open` | warning | a task is done but one of its dependencies isn't |
| `task/blocked-without-question` | warning | a task is `blocked` but has no open `- [ ]` item under `## Questions` |
| `task/not-ready` | warning | a `todo` task owned by an agent has no acceptance criteria, so the agent can only refine it |
| `task/unknown-field` | error/warn | likely typo of a field, e.g. `stauts` (error if `status` is therefore missing) |
| `link/broken` | error | a symlink points at a file that doesn't exist |
| `link/not-task` | warning | a link points at a markdown file without front matter |
| `fs/read-error` | error | a file or folder couldn't be read |

Custom fields (`estimate:`, `team:`, …) are allowed; only names that look like typos of
known ones are flagged.

To stop invalid tasks from ever being committed, run the check in CI (see
`.github/workflows/ci.yml`) or as a git pre-commit hook:

```bash
printf '#!/bin/sh\nnpx mdpm check --strict\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

## Agents

Coding agents (Claude Code, Codex, Cursor, or any CLI) can work through the backlog
unattended. A task assigned to an agent (`owner: claude`) is a queued prompt: the agent does
it the way you wrote it, writes progress and questions back into the task file, and hands
the work to you for review on a branch. The full design is in
[docs/agent-workflow.md](docs/agent-workflow.md).

```bash
mdpm agent init                      # teach agents the protocol (skill + AGENTS.md)
mdpm set export-csv owner=claude     # queue a task for Claude
mdpm agent run                       # run the next task for the default agent
mdpm agent run --task export-csv --agent codex
mdpm agent run --max-tasks 5         # work through the queue
mdpm agent run --dry-run             # show the task, command and prompt; change nothing
mdpm agent continue export-csv       # talk to the agent that worked on it, in its context
```

**What an agent works on.** `mdpm next --agent claude [--all] [--json]` returns the best task
and its *mode*:

| Mode | Task | The agent… |
|---|---|---|
| `resume` | `in-progress`, owned by the agent | continues an interrupted run from the task's log |
| `implement` | `todo` and *ready* | does the work on its branch, checks the criteria, hands off to `review` |
| `refine` | `backlog`, or `todo` but not ready | changes no code; turns the task into a ready one, then blocks it with its questions so you review the refinement |

A task is **ready** when its `## Acceptance criteria` section has at least one `- [ ] …` item
with text; a `## Verification` section is recommended. `mdpm new --template agent` (and VS
Code's New Task) creates tasks with Goal, Context, Acceptance criteria, Verification,
Constraints and Questions sections. Tasks are picked in this order: mode (resume, implement,
refine), assigned before unassigned, `priority`, `end`, `created`. A task is skipped while a
`depends_on` task isn't done, while it has validation errors, or after the agent released it;
`mdpm next --all` says why.

**How agents write back.** Agents change task state only through these commands, which
validate before writing, accept `--json`, and append a signed, timestamped entry to the
task's `## Agent log`:

| Command | Effect |
|---|---|
| `mdpm claim <id>` | `in-progress`, `owner: <agent>`, `start`; refinement keeps the status. Refuses a task someone else has (`--force` takes it over). |
| `mdpm log <id> "<text>"` | Adds a log entry. People can log too; a log entry also re-queues a released task. |
| `mdpm block <id> "<question>"…` | `blocked`; each question becomes `- [ ] (agent, date) …` under `## Questions`. |
| `mdpm handoff <id> "<summary>" [--branch b] [--pr url]` | `review`; records `branch:`/`pr:`. |
| `mdpm release <id> "<reason>"` | Back to `todo` (owner unchanged); the agent won't pick it again until someone logs on it or reassigns it. |

The agent's name comes from `--agent` or `$MDPM_AGENT`. While `MDPM_AGENT` is set, mdpm
refuses to move a task to its final status (agents hand off; people mark done) and refuses
changes to tasks the agent hasn't claimed. Answer a blocked task's questions inline, then
move it back to `todo` (or click **Unblock** in VS Code).

After a refine run the task is always `blocked`, with a question asking you to review it, so
follow-up work is visible on the board. Check the refined task, edit what's off, then
**Unblock** it (or move it to `todo`) and the next run implements it.

**Running agents.** `mdpm agent run` picks and claims a task, then runs the agent in a git
worktree (`.mdpm/worktrees/<id>`, branch `agent/<id>`), so your working copy is never
touched. Task state is written to the main checkout (`MDPM_ROOT`), so the board shows
progress live. While Claude works, the terminal shows what it is doing: its messages, each
tool call (`→ Bash: npm test`, `→ Edit: src/export.ts`) and failed tool results. The raw
output is kept in `.mdpm/runs/<run>.log`. When the agent hands off, the branch is pushed and a pull request opened with
`gh` if it is installed and logged in, and `pr:` is recorded; the worktree is then removed.
If the agent stops without handing off or blocking, the runner logs that and leaves the task
for the next run to resume (Claude resumes its previous session). A usage-limit message ends
the loop: the task stays resumable and later runs wait until the reset time. Each run is
recorded in `.mdpm/runs/` (agent, task, duration, exit code, session id, cost), which is
git-ignored. Agents are started without a shell, so it works the same on Windows, macOS and
Linux; `mdpm` is put on the agent's `PATH` for the run.

**Seeing what an agent is doing.** While an agent works on a task, a marker under
`.mdpm/active/` is refreshed every 10 seconds, and the views show it: a pulsing
**claude implementing · 3m** badge and glow on the card (board and flow board), a spinning
icon in the Projects tree, and **N agents working** in the status bar. Agent-owned tasks that
are waiting for a run show a quiet **queued** badge, so a card in Todo says what is going on.
`mdpm agent status`, `mdpm list`, `mdpm show` and `--json` output show it too. A run that
crashes or is killed stops counting after a few seconds (its process is gone) and always after
a minute without a heartbeat. The same marker stops a second run or chat from starting on a
task that an agent is already working on.

**Giving an agent more directions.** `mdpm agent continue <task>` (or **Continue with Agent**
in VS Code) opens an interactive session with the agent that worked on the task. For Claude it
reopens the latest conversation in the task's worktree (`claude --continue`), so it has the
whole context: what it read, what it tried, what it asked. If a handoff removed the worktree,
it is recreated on the task's `agent/<id>` branch first. With no earlier conversation, or with
`--fresh`, a new one starts with the task, its log and its questions as the opening message.
You answer permission prompts yourself, and `MDPM_AGENT` isn't set, so the agent-only
restrictions don't apply; the agent can still `mdpm log` and `mdpm handoff` as usual. Each
use adds a line to the task's Agent log. Custom agents opt in with `interactive` (and
optionally `continueInteractive`) commands, e.g. `interactive: [my-agent, chat, "{prompt}"]`.

**Configuration.** In any `.proj` (inherited key by key):

```yaml
agent:
  enabled: true          # agents may work here (default true)
  unassigned: false      # also pick tasks without an owner (default false)
  modes: [resume, implement, refine]
  maxTurns: 50           # per task run
  allowedTools: ["Bash(mdpm *)", "Bash(git commit *)", "Bash(npm test)"]   # passed to Claude's --allowedTools
```

In the root `.proj`, `agents:` picks the default and overrides or adds agent commands.
Commands are argument lists (never shell strings) with placeholders `{prompt}`,
`{promptFile}`, `{taskFile}`, `{taskId}`, `{worktree}`, `{root}`, `{maxTurns}`,
`{allowedTools}` and `{sessionId}`:

```yaml
agents:
  default: claude
  my-agent:
    command: [my-agent, --task-file, "{taskFile}", --cwd, "{worktree}", "{prompt}"]
  codex:
    command: [codex, exec, "-"]
    stdin: true          # send the prompt on stdin instead of as an argument
```

Built in: `claude` (`claude -p` with `acceptEdits`, `--permission-prompts none`, `--max-turns`,
`--add-dir <root>`, `--allowedTools`, prompt on stdin, `--output-format stream-json` shown as
live progress; set `output: claude-json` or `text` on a custom agent for other formats), `codex` (`codex exec -`)
and `cursor` (`cursor-agent -p`).

**Teaching agents the protocol.** `mdpm agent init` writes `.claude/skills/mdpm/SKILL.md` and
a section of `AGENTS.md` (read by Codex, Cursor and others) between markers; re-running it
updates only that part. `--claude-hook` also adds a Claude Code Stop hook
(`mdpm check --hook`) that keeps a run going while its task is invalid or has nothing written
back since the claim. The runner also puts the protocol into every prompt.

Before running agents unattended at volume, check that it is consistent with your plan's
usage terms.

## VS Code extension

```bash
npm run install-extension     # build, package and install into your VS Code
```

Then run **Developer: Reload Window** (Cmd/Ctrl+Shift+P). The extension activates in any
workspace containing a `.proj` file. After changing the extension's code, run the same two
steps again. To debug it with breakpoints instead, press F5 (*Run Extension*), which opens
a separate development window.

- **Projects view** (activity bar): project tree with tasks; right-click to set status/owner,
  link a task into another project, create tasks and sub projects.
- **Kanban board**: columns from `statuses`; drag cards to change status; filter by project
  (includes sub projects), owner, or text; `+` on a column creates a task in that status.
- **AI flow board** (*mdpm: Open AI Flow Board*): the same tasks in five lanes for working
  with agents: **Idea** (you write what you want; `backlog`) → **Planned** (the agent's plan,
  i.e. acceptance criteria; `todo`) → **Building** (the agent codes; `in-progress`) →
  **Review** (you check the work; `review`) → **Done** (the final status). `blocked` tasks
  stay in the lane they were blocked from, flagged *Needs your answer*; the toolbar counts
  what is waiting on you. Cards show acceptance-criteria progress and the handed-off branch.
  Dragging a card sets the lane's status.
- **Waterfall**: Gantt timeline from `start`/`end`, grouped by project, with dependency
  arrows (red when a task starts before its dependency ends). Drag a bar to move it, drag
  its edges to change start/end, click an unscheduled row to schedule it. Day/week/month zoom.
- **Continue with Agent** (💬 on agent-owned cards, the task's context menu, or the editor
  title) opens a terminal `mdpm · chat · <id>` with that conversation, to give more directions.
- **Agents**: *Send to Agent* (hover a card, the task's context menu, or the editor title)
  runs `mdpm agent run --task <id>` in a terminal named `mdpm · claude · <id>`, using the CLI
  bundled with the extension. *Send to Agent…* picks another agent; *Queue for Agent…* only
  sets the owner, for the next run to pick up. Blocked tasks get *Unblock*, which opens the
  questions and moves the task back to `todo`. Agent-owned cards show a 🤖 badge.
- Validation problems (see [Validation](#validation)) show in the
  Problems panel. `.task` files open as markdown, `.proj` as YAML.
- Settings: `mdpm.root` (subfolder to scan in large repos), `mdpm.defaultOwner`,
  `mdpm.agent.default` (agent for *Send to Agent*, default `claude`), `mdpm.taskTemplate`
  (`agent` or `default` body for new tasks).

Every change is a plain edit of the front matter (comments, key order and line endings are
preserved), so it shows up as a clean git diff.

## Development

```
packages/core     parsing, scanning, linking, editing (TypeScript, only depends on `yaml`)
packages/cli      `mdpm` command (bundled with esbuild)
packages/vscode   extension; webviews are plain JS in media/
tasks/            mdpm's own backlog, managed with mdpm
```

```bash
npm install
npm test            # vitest
npm run typecheck
npm run build
```

## License

[MIT](LICENSE) — free to use, modify and distribute. Contributions welcome: open an issue
or pull request at <https://github.com/availabooks/mdpm>.
