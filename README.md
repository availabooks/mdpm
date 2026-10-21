# mdpm — an AI flow that lives in your repo

You write an idea. The agent turns it into a plan. You approve the plan, and the agent builds
it, one idea at a time, while you're away. You review the work. Everything is a markdown file
in git, so people, VS Code and agents (Claude, Codex, Cursor, …) read and update the same
files.

```
idea ──▶ plan ──▶ executing ──▶ review ──▶ done
 you    agent drafts,  agent,        you        you
        you approve    one at a time
  ▲         ▲              ▲
  └─────────┴──────────────┴── blocked (waiting for your answer; returns to where it came from)
```

Speed isn't the point: the agent works through approved plans, and plans new ideas, whenever
there is spare subscription usage. The design is in [docs/agent-workflow.md](docs/agent-workflow.md).

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
    └── oauth-login.md -> ../website/auth/oauth-login.md   ← shared idea (symlink)
```

It works on its own repo or embedded inside a code repo (e.g. a `tasks/` folder next to `src/`).

## The flow

| Status | Who acts | Meaning |
|---|---|---|
| `idea` | you write it | What you want built, in your own words. The agent plans it. |
| `plan` | agent drafts, you approve | The agent has written a plan. It waits until you approve it (`approved:` is set); approved plans are queued for execution. |
| `executing` | agent | The agent builds it on the idea's branch. **At most one idea executes at a time.** |
| `blocked` | you answer | The agent has questions (`## Questions`). `blocked_from:` records where it returns. |
| `review` | you check | The work is on a branch (and a pull request, when `gh` is set up). Accept it, or send it back with feedback. |
| `done` | you | Accepted. Only a person moves an idea to done. |

**One idea at a time.** There is one *execution slot*, held by the idea that is `executing`,
or by one that is `blocked` while executing. While the slot is taken no other idea starts
executing, even when the idea in it waits for your answer. The agent can still **plan** other
ideas meanwhile, because planning doesn't change code.

## File format

### Projects: `.proj`

Any folder containing a `.proj` file is a project. A project folder inside another one is a
sub project. Folders *without* a `.proj` inside a project are just organisation; their ideas
belong to the nearest project above them. Projects group ideas; they don't change the flow.

```yaml
name: Website
description: Marketing site and customer portal
owner: eli
taskExtension: .md        # or .task — extension for new ideas
ignore: [assets]          # folder names to skip while scanning
agent:                    # what coding agents may do here (see Agents)
  maxTurns: 50
# any other keys are kept and passed through
```

`taskExtension` and `agent` are inherited by sub projects that don't set their own.

### Ideas: `*.md` or `*.task`

An idea is a `.md` or `.task` file inside a project that **starts with a YAML front matter
block**. Markdown files without front matter (READMEs, notes) are ignored.

```markdown
---
title: Export the board as CSV
status: plan
author: Elijah Allen
created: 2026-10-20
priority: 2                  # number (lower is sooner), or high / medium / low
tags: [export]
approved: 2026-10-21         # set by mdpm approve; absent while the plan waits for you
branch: idea/export-the-board-as-csv   # set when execution starts
---

# Export the board as CSV

## Idea
What you want, in your own words. This is the only part you have to write.

## Plan
The agent's approach: what it will change, where, and in which order.

## Acceptance criteria
- [ ] The export button downloads a CSV

## Verification
`npm test`, or steps to try by hand.

## Questions
- [ ] (claude, 2026-10-20) Include archived ideas?

## Log
- 2026-10-20 02:14 claude — planned: CSV export from the CLI and the board
```

| Field | Meaning |
|---|---|
| `id` | Optional. Defaults to the file name without extension. Must be unique. |
| `title` | Defaults to the first `# heading`, then the file name. |
| `status` | `idea`, `plan`, `executing`, `blocked`, `review` or `done`. Defaults to `idea`. |
| `author`, `created` | Who wrote it, and when (`YYYY-MM-DD`). |
| `priority` | Number (lower = sooner) or a word. Orders the queues. |
| `tags` | List of strings. |
| `approved` | Date the plan was approved. Set by `mdpm approve`. |
| `blocked_from` | While blocked: the status the idea returns to. Set by `mdpm block`. |
| `branch`, `pr` | Where the work is. Set when execution starts, and on handoff. |
| `completed` | Date the idea was accepted. |

A plan is **complete** when `## Acceptance criteria` has at least one `- [ ] …` item with
text; only complete plans can be approved. Any other front matter keys are preserved
untouched, so you can add your own fields.

### Sharing an idea between projects

Don't copy the idea; symlink it. `mdpm link <idea> <project>` (or *Add to Another Project*
in VS Code) creates a relative symlink. The idea is counted once, edited in one place, and
appears in every project that links to it.

**Windows:** creating symlinks needs Developer Mode (or admin), and git needs
`git config core.symlinks true` to check them out as real links. If symlinks aren't
available, git writes a one-line text file containing the relative path instead. mdpm
recognises these *stub files* and treats them exactly like symlinks, and falls back to
writing one itself when it can't create a symlink. A repo therefore works the same on
Windows, macOS and Linux either way.

### Coming from the task-based mdpm

`mdpm migrate` shows how a task-based workspace maps onto the flow, and `mdpm migrate --write`
applies it: `backlog` becomes an idea, `todo` a plan if it has acceptance criteria (approved if it was queued for an agent),
`in-progress` becomes `executing` (one keeps the slot; others become approved plans), `blocked`
gets its `blocked_from`, and `done` keeps its date as `completed`. `owner`, `start`, `end`,
`depends_on`, custom `statuses` and the `required…` rules are removed, and `## Agent log` /
`## Description` become `## Log` / `## Idea`. Statuses it can't map are reported, not guessed.

## CLI

```bash
npm install && npm run build
npm link -w @mdpm/cli          # puts `mdpm` on your PATH (or: node packages/cli/dist/mdpm.js)
```

```bash
mdpm init tasks -n "My Product"         # root project in ./tasks
mdpm project tasks/website              # sub project
mdpm idea "Export the board as CSV" -p website --priority 2 -t export
mdpm board                              # the flow, plus the execution slot and what waits on you
mdpm list -s plan,review                # filter; add --json for machine-readable output
mdpm show export-the-board-as-csv       # by id or path

mdpm approve export-the-board-as-csv    # the plan joins the execution queue
mdpm unblock export-the-board-as-csv "Yes, include archived ideas"
mdpm rework export-the-board-as-csv "Add a header row"     # review → front of the queue
mdpm accept export-the-board-as-csv     # review → done
mdpm move export-the-board-as-csv idea  # the escape hatch (still one idea executing at a time)

mdpm set export-the-board-as-csv priority=1 tags=ui,export   # other fields; empty value deletes
mdpm link oauth-login mobile            # share an idea with another project
mdpm unlink oauth-login mobile
mdpm projects
mdpm check                              # validate everything (exit code 1 on errors)
mdpm check --strict --json              # warnings fail too; machine-readable report
mdpm migrate [--write]                  # from the task-based mdpm
```

Every write is validated **before** it is made. If the change would break a rule or the flow,
nothing is written, the problem is printed (with its rule code where there is one), and the
exit code is 1. `--force` writes anyway where that makes sense.

The root is found automatically: `--root`, else `$MDPM_ROOT`, else the enclosing git repo,
else the topmost folder with a `.proj`. Projects are referenced by folder path relative to
the root (`tasks/website`) or by unique name (`website`). `list`, `show`, `projects`, `idea`,
`check`, `next` and the flow commands accept `--json`; `check --task <id>` checks one idea.

## Validation

Because agents (and people) edit ideas unattended, mdpm checks every `.proj` and every
idea's front matter. Problems come with a stable **rule code**, the **line** they're on, and
a message that says how to fix them. You'll see them in:

- `mdpm check`, for CI and agents. `--strict` makes warnings fail too, and `--json` prints a report with `ok`, counts and each issue's `code`, `file`, `line`, `field` and `message`.
- every write: the CLI commands and the VS Code board and tree refuse changes that would introduce an error (VS Code offers *Save Anyway*). Problems an idea already had never block an unrelated change.
- the VS Code Problems panel, underlined on the offending line.

| Code | Level | Meaning |
|------|-------|---------|
| `proj/yaml-invalid` | error | `.proj` isn't valid YAML, or isn't `key: value` lines |
| `proj/field-type` | error | a setting has the wrong type (e.g. `ignore: assets` instead of a list) |
| `proj/field-value` | error/warn | `taskExtension` isn't `.md`/`.task`; `ignore` contains paths or globs |
| `proj/unknown-field` | error/warn | likely typo of a setting (error if the intended setting is therefore missing) |
| `proj/obsolete-field` | warning | `statuses`, `required`, `requiredByStatus`, `agent.unassigned` or `agent.modes` from the task-based mdpm (`mdpm migrate`) |
| `proj/agent-unknown` | error | `agents.default` names an agent that isn't defined |
| `proj/agents-not-root` | warning | `agents` is set in a sub project's `.proj`, where it is ignored |
| `task/yaml-invalid` | error | front matter isn't valid YAML, or isn't `key: value` lines |
| `task/field-type` | error | e.g. `status: [idea]`, `tags: {a: 1}` |
| `task/status-unknown` | error | `status` isn't one of the flow's statuses (old task statuses point to `mdpm migrate`) |
| `task/date-invalid` | error | `created`/`approved`/`completed` isn't a real `YYYY-MM-DD` date |
| `task/duplicate-id` | error | two ideas share an id |
| `task/slot-taken` | error | more than one idea holds the execution slot |
| `task/blocked-from-missing` | error | a blocked idea has no `blocked_from` |
| `task/blocked-from-invalid` | error | `blocked_from` isn't `idea`, `plan` or `executing` |
| `task/blocked-from-stale` | warning | `blocked_from` on an idea that isn't blocked |
| `task/blocked-without-question` | warning | an idea is `blocked` but has no open `- [ ]` item under `## Questions` |
| `task/approved-idea` | warning | `approved` on an idea that has no plan yet |
| `task/plan-incomplete` | warning | an approved plan has no acceptance criteria |
| `task/obsolete-field` | warning | `owner`, `start`, `end` or `depends_on` from the task-based mdpm |
| `task/obsolete-section` | warning | `## Agent log` or `## Description` (now `## Log` and `## Idea`) |
| `task/unknown-field` | error/warn | likely typo of a field, e.g. `stauts` (error if `status` is therefore missing) |
| `link/broken` | error | a symlink points at a file that doesn't exist |
| `link/not-task` | warning | a link points at a markdown file without front matter |
| `fs/read-error` | error | a file or folder couldn't be read |

Custom fields (`estimate:`, `team:`, …) are allowed; only names that look like typos of
known ones are flagged.

To stop invalid ideas from ever being committed, run the check in CI (see
`.github/workflows/ci.yml`) or as a git pre-commit hook:

```bash
printf '#!/bin/sh\nnpx mdpm check --strict\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

## Agents

Coding agents (Claude Code, Codex, Cursor, or any CLI) work through the flow unattended: they
plan your ideas, and build your approved plans one at a time. They write plans, progress and
questions back into the idea file, and hand finished work to you on a branch.

```bash
mdpm agent init                      # teach agents the flow (skill + AGENTS.md)
mdpm agent run                       # one run: the next thing in the flow
mdpm agent run --until-idle          # keep going until nothing is left or usage runs out
mdpm agent run --idea export-csv     # plan or execute this idea now
mdpm agent run --dry-run             # show the idea, command and prompt; change nothing
mdpm agent status                    # what runs, what holds the slot, what is next
mdpm agent continue export-csv       # talk to the agent about an idea, in its worktree
```

**What the agent does next.** `mdpm next [--all] [--json]` answers it:

1. **Execute (resume)** the idea that is `executing`, if any.
2. If the slot is free, **execute** the top approved plan. Plans sent back from review come
   first, then by `priority`, then by approval date.
3. Otherwise **plan** the top `idea`, by `priority`, then oldest first.
4. Nothing: everything waits on you. `mdpm next --all` says why each idea waits.

| Mode | The agent… | Ends with |
|---|---|---|
| `plan` | reads the code, changes none of it, writes Plan, Acceptance criteria, Verification and any Questions into the idea | `mdpm propose` (→ `plan`, waiting for your approval), or `mdpm block` |
| `execute` | works on the idea's branch, ticks the criteria, runs the verification | `mdpm handoff` (→ `review`), or `mdpm block` |

**How agents write back.** Agents change an idea's state only through these commands, which
validate before writing, accept `--json`, and add a signed, timestamped line to `## Log`:

| Command | Effect |
|---|---|
| `mdpm propose <id> "<summary>"` | `idea` → `plan`, waiting for approval. Needs acceptance criteria. |
| `mdpm start <id>` | an approved `plan` → `executing`, on branch `idea/<id>`. Refused while the slot is taken. |
| `mdpm log <id> "<text>"` | Adds a log entry. |
| `mdpm block <id> "<question>"…` | → `blocked`, with `blocked_from`; each question becomes `- [ ] (agent, date) …` under `## Questions`. |
| `mdpm handoff <id> "<summary>" [--pr url]` | `executing` → `review`. |

The agent's name comes from `--agent` or `$MDPM_AGENT`. While `MDPM_AGENT` is set, mdpm
refuses `approve`, `unblock`, `rework`, `accept`, `move` and `set` (those are your calls), and
refuses changes to any idea other than the run's own (`$MDPM_TASK`).

**Running agents.** `mdpm agent run` does one run at a time per workspace (a second one is
refused, saying what is running). Every run uses one git worktree, `.mdpm/agent/`, so your
checkout is never touched:

- **Plan runs** read a detached checkout of the default branch (the remote's default, else
  `main`/`master`). A plan run that ends without proposing is blocked with a question, unless
  it wrote a complete plan, which then waits for your approval.
- **Execute runs** work on `idea/<id>`, created from the default branch the first time and
  kept on rework. A run that stops without handing off leaves the idea `executing`, and the
  next run resumes it (Claude resumes its session).
- **Switching** between ideas never loses work: uncommitted changes are committed to their
  idea's branch first (`wip: blocked on questions`), or stashed if a plan run left any.
- **On handoff** the branch is pushed and a pull request opened with `gh` when it is installed
  and logged in, and `pr:` is recorded; the worktree then lets go of the branch, so you can
  check it out to review.
- **Idea files** are edited in the main checkout (`MDPM_ROOT`), so the board shows progress live.

While Claude works, the terminal shows its messages and each tool call
(`→ Bash: npm test`, `→ Edit: src/export.ts`). The raw output is kept in
`.mdpm/runs/<run>.log`, and each run is recorded in `.mdpm/runs/` (agent, idea, mode,
duration, exit code, session id, cost), which is git-ignored. A usage-limit message ends the
run and the loop; later runs wait until the reset time. Agents are started without a shell,
so it works the same on Windows, macOS and Linux; `mdpm` is put on the agent's `PATH`.

**Seeing what the agent is doing.** While an agent works, a marker under `.mdpm/active/` is
refreshed every 10 seconds, and the views show it: a pulsing **claude executing · 3m** badge
on the card, a spinning icon in the Projects tree, and the status bar. A run that crashes or
is killed stops counting after a few seconds (its process is gone), and always after a minute
without a heartbeat. The same marker is the "one run at a time" lock.

**Giving the agent more directions.** `mdpm agent continue <idea>` (or **Continue with
Agent** in VS Code) opens an interactive session in the agent worktree, on the idea's branch.
For Claude it reopens the session of the agent's last run on that idea (`claude --resume`),
so it has the whole context; with no earlier run, or with `--fresh`, a new conversation starts
from the idea. You answer permission prompts yourself, and `MDPM_AGENT` isn't set. Custom
agents opt in with `interactive` (and optionally `continueInteractive`) commands, e.g.
`interactive: [my-agent, chat, "{prompt}"]`.

**Configuration.** In any `.proj` (inherited key by key):

```yaml
agent:
  enabled: true          # agents may plan and execute ideas here (default true)
  maxTurns: 50           # per run
  allowedTools: ["Bash(mdpm *)", "Bash(git commit *)", "Bash(npm test)"]   # passed to Claude's --allowedTools
```

In the root `.proj`, `agents:` picks the default and overrides or adds agent commands.
Commands are argument lists (never shell strings) with placeholders `{prompt}`,
`{promptFile}`, `{taskFile}` (the idea file), `{taskId}`, `{worktree}`, `{root}`,
`{maxTurns}`, `{allowedTools}` and `{sessionId}`:

```yaml
agents:
  default: claude
  my-agent:
    command: [my-agent, --file, "{taskFile}", --cwd, "{worktree}", "{prompt}"]
  codex:
    command: [codex, exec, "-"]
    stdin: true          # send the prompt on stdin instead of as an argument
```

Built in: `claude` (`claude -p` with `acceptEdits`, `--permission-prompts none`, `--max-turns`,
`--add-dir <root>`, `--allowedTools`, prompt on stdin, `--output-format stream-json` shown as
live progress; set `output: claude-json` or `text` on a custom agent for other formats),
`codex` (`codex exec -`) and `cursor` (`cursor-agent -p`).

**Teaching agents the flow.** `mdpm agent init` writes `.claude/skills/mdpm/SKILL.md` and
a section of `AGENTS.md` (read by Codex, Cursor and others) between markers; re-running it
updates only that part. `--claude-hook` also adds a Claude Code Stop hook
(`mdpm check --hook`) that keeps a run going while its idea is invalid or has nothing written
back since the run started. The runner also puts the protocol into every prompt.

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

- **Flow board** (*mdpm: Open Flow Board*): the columns **Idea · Plan · Executing · Review ·
  Done**. Blocked ideas stay yellow in the column they were blocked from, flagged *Needs your
  answer*. Plan cards say *Awaiting your approval* or *Approved · #n in queue*; review cards
  say *Ready for your review*. The toolbar shows the execution slot ("Executing: export-csv ·
  claude 12m", "Slot free · 3 approved plans waiting"), **Waiting on you: N**, **▶ Run next**
  and **＋ New idea**.
- **Card actions**, on hover: Idea → **▶ Plan now**; Plan → **✓ Approve**, ↺ re-plan;
  Executing → 💬 continue with the agent; Blocked → **Answer** (opens the questions, asks for
  your answer, unblocks); Review → **✓ Accept**, ↩ rework (asks what to change), PR.
- **Dragging** a card does what that move means in the flow: Plan → Executing starts an
  approved plan, Review → Done accepts, Review → Plan sends it back, Plan → Idea re-plans,
  Idea → Plan approves a complete plan. Other moves are refused, and the board says why.
- **Selecting several**: Ctrl/Cmd+click cards, then **Approve** or **Accept** in the toolbar.
- **Projects view** (activity bar): projects, with their ideas grouped by stage. The same
  actions are on each idea's context menu (and inline), and in the editor title for the open
  idea file.
- **Runs** start in a terminal (`mdpm · claude · <id>`) using the CLI bundled with the
  extension, so nothing needs to be on `PATH`. Only one runs at a time.
- Validation problems (see [Validation](#validation)) show in the Problems panel. `.task`
  files open as markdown, `.proj` as YAML.
- Settings: `mdpm.root` (subfolder to scan in large repos) and `mdpm.agent.default` (agent for
  *Plan Now* and *Run Agent*, default `claude`).

Every change is a plain edit of the idea file (comments, key order and line endings are
preserved), so it shows up as a clean git diff.

## Development

```
packages/core     parsing, scanning, the flow, validation, the runner (TypeScript, only depends on `yaml`)
packages/cli      `mdpm` command (bundled with esbuild)
packages/vscode   extension; the board webview is plain JS in media/
tasks/            mdpm's own ideas, managed with mdpm
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
