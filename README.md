# mdpm — markdown project management that lives in your repo

Tasks are markdown files. Projects are folders. Everything is plain text in git, so humans,
VS Code, and AI agents (Claude, Cursor, …) can all read and update the same backlog.

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
statuses: [backlog, todo, in-progress, review, done]   # Kanban columns, in order
taskExtension: .md        # or .task — extension for new tasks
ignore: [assets]          # folder names to skip while scanning
required: [owner]         # fields every task must have
requiredByStatus:         # extra fields a task needs before it may enter a status
  in-progress: [owner, start]
  done: [end]
# any other keys are kept and passed through
```

`statuses`, `taskExtension`, `required` and `requiredByStatus` are inherited by sub projects
that don't set their own. The
default statuses are `backlog, todo, in-progress, review, done`. The **last** status is
treated as "done" (for overdue highlighting and the waterfall view).

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

The root is found automatically: `--root`, else `$MDPM_ROOT`, else the enclosing git repo,
else the topmost folder with a `.proj`. Projects are referenced by folder path relative to
the root (`tasks/website`) or by unique name (`website`). `list`, `show`, `projects`, `new`
and `check` accept `--json`.

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

## VS Code extension

```bash
npm run build && cd packages/vscode && npx vsce package --no-dependencies
code --install-extension mdpm-vscode-0.1.0.vsix
```

Or open this repo in VS Code and press F5 (*Run Extension*) for a development host.

- **Projects view** (activity bar): project tree with tasks; right-click to set status/owner,
  link a task into another project, create tasks and sub projects.
- **Kanban board**: columns from `statuses`; drag cards to change status; filter by project
  (includes sub projects), owner, or text; `+` on a column creates a task in that status.
- **Waterfall**: Gantt timeline from `start`/`end`, grouped by project, with dependency
  arrows (red when a task starts before its dependency ends). Drag a bar to move it, drag
  its edges to change start/end, click an unscheduled row to schedule it. Day/week/month zoom.
- Validation problems (see [Validation](#validation)) show in the
  Problems panel. `.task` files open as markdown, `.proj` as YAML.
- Settings: `mdpm.root` (subfolder to scan in large repos), `mdpm.defaultOwner`.

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
