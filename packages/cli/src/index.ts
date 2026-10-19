import {
  ActiveRun,
  AgentError,
  BLOCKED_STATUS,
  DEFAULT_STATUSES,
  Issue,
  Project,
  RunnerError,
  TASK_TEMPLATES,
  Task,
  TaskTemplate,
  WriteBack,
  Workspace,
  agentDefinitions,
  agentGuard,
  agentInit,
  agentLog,
  activityVerb,
  ago,
  agentQueue,
  applyStatusDefaults,
  bodyAfter,
  createProject,
  createTask,
  defaultAuthor,
  findProject,
  findRoot,
  findTask,
  isFinalStatus,
  loadActive,
  lastEntryIsClaim,
  linkTask,
  loadWorkspace,
  newTaskMeta,
  nextTaskPath,
  openQuestions,
  planBlock,
  planClaim,
  planContinue,
  planHandoff,
  planRelease,
  previewNewTask,
  previewTaskChange,
  projectSubtree,
  runAgents,
  runInteractive,
  runId,
  suggest,
  taskBody,
  tasksInProject,
  toPosix,
  today,
  unlinkTask,
  updateTask,
  writeBack,
} from '@mdpm/core';
import { Command } from 'commander';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

const LIST_KEYS = new Set(['tags', 'depends_on']);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);

const program = new Command()
  .name('mdpm')
  .description('Markdown task management that lives in your repo')
  .version('0.1.0')
  .option('-r, --root <dir>', 'folder to scan (default: $MDPM_ROOT, git root, or topmost .proj)');

function root(): string {
  const opt = program.opts().root as string | undefined;
  return opt ? path.resolve(opt) : findRoot(process.cwd());
}

/** Agents working right now, loaded with the workspace; shown next to their tasks. */
let activeRuns: ActiveRun[] = [];
const runningOn = (t: Task) => activeRuns.find((r) => r.task === t.id);
const runningText = (r: ActiveRun) => `${r.agent} ${activityVerb(r.mode)} · ${ago(r.started)}`;

async function load(): Promise<Workspace> {
  const ws = await loadWorkspace(root());
  activeRuns = await loadActive(ws.root);
  if (!ws.projects.length) {
    fail(
      `No projects found under ${ws.root} (a project is a folder containing a .proj file).\n` +
        `  • To start one here, run: mdpm init        (creates ./tasks/.proj)\n` +
        `  • If your tasks live elsewhere, run with --root <folder> or set MDPM_ROOT.`,
    );
  }
  return ws;
}

/** Set by commands with --json, so failures are also reported as JSON on stdout. */
let jsonErrors = false;

function fail(msg: string, issues: Issue[] = []): never {
  console.error(red(`error: ${msg}`));
  if (jsonErrors) console.log(JSON.stringify({ ok: false, error: msg, issues }, null, 2));
  process.exit(1);
}

/** The agent running this command (`MDPM_AGENT`), whose writes are restricted. */
const envAgent = process.env.MDPM_AGENT?.trim() || undefined;

/** Refuses writes an agent isn't allowed to make (see agentGuard). No-op for people. */
function agentCheck(t: Task, changes: Record<string, unknown>) {
  if (!envAgent) return;
  const why = agentGuard(t, changes, envAgent);
  if (why) fail(`MDPM_AGENT is "${envAgent}": ${why}`);
}

/** Who signs a write-back: --agent, else $MDPM_AGENT, else the git user. */
function signer(o: { agent?: string }): string {
  return o.agent?.trim() || envAgent || defaultAuthor();
}

/**
 * Prints the problems a pending write would cause. Errors stop the write (exit code 1, nothing
 * changed) unless --force is given; warnings are printed and the write goes ahead.
 */
function guard(ws: Workspace, issues: Issue[], force: boolean | undefined) {
  for (const i of issues.filter((i) => i.level === 'warning')) console.warn(yellow(`warning [${i.code}]: ${i.message}`));
  const errors = issues.filter((i) => i.level === 'error');
  if (!errors.length) return;
  for (const i of errors) console.error(red(`error [${i.code}]: ${i.message}`));
  if (force) {
    console.warn(yellow('--force given, so writing anyway. Run "mdpm check" to see the remaining problems.'));
    return;
  }
  fail(`Nothing was changed. Fix the value${errors.length > 1 ? 's' : ''} above and try again, or add --force to write anyway.`, issues.map((i) => ({ ...i, file: rel(ws, i.file) })));
}

function statusText(s: string): string {
  return s === BLOCKED_STATUS ? yellow(s) : s;
}

function formatIssue(ws: Workspace, i: Issue): string {
  const where = `${rel(ws, i.file)}${i.line ? `:${i.line}` : ''}`;
  return `${i.level === 'error' ? red('error') : yellow('warn ')}  ${where}  ${dim(`[${i.code}]`)}\n       ${i.message.replace(/\n/g, '\n       ')}`;
}

function alreadyProject(dir: string): string {
  return `${dir} is already a project (it has a .proj). Pick another folder, or edit ${path.join(dir, '.proj')} instead.`;
}

function rel(ws: Workspace, p: string): string {
  return toPosix(path.relative(ws.root, p)) || '.';
}

function getTask(ws: Workspace, ref: string): Task {
  const task = findTask(ws, ref);
  if (task) return task;
  const hint = suggest(ref, ws.tasks.map((t) => t.id));
  fail(`No task with id or path "${ref}".${hint ? ` Did you mean "${hint}"?` : ''} Run "mdpm list" to see task ids.`);
}

function getProject(ws: Workspace, ref: string): Project {
  const project = findProject(ws, ref);
  if (project) return project;
  const lower = ref.toLowerCase();
  const ambiguous = ws.projects.filter((p) => p.name.toLowerCase() === lower || path.basename(p.dir).toLowerCase() === lower);
  if (ambiguous.length > 1) {
    fail(`"${ref}" matches several projects: ${ambiguous.map((p) => p.id).join(', ')}. Use the full folder path instead, e.g. -p ${ambiguous[0].id}`);
  }
  const hint = suggest(ref, ws.projects.map((p) => p.id));
  fail(
    `No project "${ref}".${hint ? ` Did you mean "${hint}"?` : ''} Refer to a project by its folder path relative to ${ws.root} ` +
      `(e.g. ${ws.projects[ws.projects.length - 1].id}), its name, or its folder name. Run "mdpm projects" to list them.`,
  );
}

/** The project containing the current directory, or the first root project. */
function currentProject(ws: Workspace): Project {
  const cwd = process.cwd();
  const containing = ws.projects
    .filter((p) => cwd === p.dir || cwd.startsWith(p.dir + path.sep))
    .sort((a, b) => b.dir.length - a.dir.length);
  return containing[0] ?? ws.projects[0];
}

function taskJson(ws: Workspace, t: Task) {
  return {
    ...taskFields(ws, t),
    meta: t.meta,
  };
}

function taskFields(ws: Workspace, t: Task) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    owner: t.owner,
    author: t.author,
    created: t.created,
    start: t.start,
    end: t.end,
    priority: t.priority,
    tags: t.tags,
    depends_on: t.dependsOn,
    file: rel(ws, t.file),
    project: t.home.id,
    projects: t.locations.map((l) => ({ project: l.project.id, path: rel(ws, l.path), link: l.link })),
    branch: typeof t.meta.branch === 'string' ? t.meta.branch : undefined,
    pr: typeof t.meta.pr === 'string' ? t.meta.pr : undefined,
    running: runningOn(t) && { agent: runningOn(t)!.agent, mode: runningOn(t)!.mode, since: runningOn(t)!.started },
  };
}

function taskLine(ws: Workspace, t: Task): string {
  const bits = [
    bold(t.title),
    dim(`[${t.id}]`),
    t.owner ? `@${t.owner}` : '',
    t.priority !== undefined ? `p:${t.priority}` : '',
    t.start || t.end ? dim(`${t.start ?? '?'} → ${t.end ?? '?'}`) : '',
    t.tags.length ? dim(t.tags.map((x) => `#${x}`).join(' ')) : '',
    t.locations.length > 1 ? dim(`(shared: ${t.locations.map((l) => l.project.name).join(', ')})`) : '',
    runningOn(t) ? green(`⚙ ${runningText(runningOn(t)!)}`) : '',
  ];
  return bits.filter(Boolean).join('  ');
}

/** Turns `key=value` pairs into front matter changes. Values are parsed as YAML scalars. */
function parseAssignments(pairs: string[]): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i < 1) fail(`Expected key=value (e.g. status=done), got "${pair}". To delete a field, leave the value empty (e.g. owner=).`);
    const key = pair.slice(0, i).trim();
    const raw = pair.slice(i + 1).trim();
    if (raw === '') changes[key] = null;
    else if (LIST_KEYS.has(key) && !raw.startsWith('[')) changes[key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    else {
      const v = parseYaml(raw);
      changes[key] = v === null ? raw : v;
    }
  }
  return changes;
}

function filterTasks(ws: Workspace, opts: { status?: string; owner?: string; project?: string; tag?: string }): Task[] {
  let tasks = opts.project ? tasksInProject(ws, getProject(ws, opts.project)) : ws.tasks;
  if (opts.status) {
    const wanted = new Set(opts.status.split(','));
    tasks = tasks.filter((t) => wanted.has(t.status));
  }
  if (opts.owner) tasks = tasks.filter((t) => (opts.owner === '-' ? !t.owner : t.owner === opts.owner));
  if (opts.tag) tasks = tasks.filter((t) => t.tags.includes(opts.tag!));
  return tasks;
}

program
  .command('init [dir]')
  .description('create a root project (.proj) in dir (default: ./tasks)')
  .option('-n, --name <name>', 'project name')
  .option('--statuses <list>', 'comma separated kanban columns')
  .action(async (dir: string | undefined, o: { name?: string; statuses?: string }) => {
    const target = path.resolve(dir ?? 'tasks');
    const file = await createProject(target, {
      name: o.name ?? path.basename(path.resolve(target, dir ? '.' : '..')),
      description: '',
      owner: defaultAuthor(),
      statuses: o.statuses ? o.statuses.split(',').map((s) => s.trim()) : DEFAULT_STATUSES,
    }).catch((e) => fail(e.code === 'EEXIST' ? alreadyProject(target) : e.message));
    console.log(`Created ${file}`);
  });

program
  .command('project <dir>')
  .description('create a (sub) project folder; dir is relative to the current folder')
  .option('-n, --name <name>', 'project name (default: folder name)')
  .option('-d, --description <text>', 'description')
  .option('--owner <name>', 'owner')
  .action(async (dir: string, o: { name?: string; description?: string; owner?: string }) => {
    const target = path.resolve(dir);
    const file = await createProject(target, {
      name: o.name ?? path.basename(target),
      description: o.description ?? '',
      owner: o.owner ?? defaultAuthor(),
    }).catch((e) => fail(e.code === 'EEXIST' ? alreadyProject(target) : e.message));
    console.log(`Created ${file}`);
  });

program
  .command('projects')
  .description('list projects as a tree')
  .option('--json', 'machine readable output')
  .action(async (o: { json?: boolean }) => {
    const ws = await load();
    if (o.json) {
      const out = ws.projects.map((p) => ({
        id: p.id,
        name: p.name,
        parent: p.parent?.id,
        statuses: p.statuses,
        tasks: tasksInProject(ws, p, false).length,
        meta: p.meta,
      }));
      return console.log(JSON.stringify(out, null, 2));
    }
    const print = (p: Project, depth: number) => {
      const count = tasksInProject(ws, p, false).length;
      console.log(`${'  '.repeat(depth)}${bold(p.name)} ${dim(`${p.id}  (${count} tasks)`)}`);
      p.children.forEach((c) => print(c, depth + 1));
    };
    ws.projects.filter((p) => !p.parent).forEach((p) => print(p, 0));
  });

program
  .command('new <title...>')
  .description('create a task')
  .option('-p, --project <project>', 'project id/path/name (default: project containing cwd)')
  .option('-s, --status <status>')
  .option('-o, --owner <owner>')
  .option('-a, --author <author>', 'default: git user.name')
  .option('--start <date>', 'YYYY-MM-DD')
  .option('--end <date>', 'YYYY-MM-DD')
  .option('--priority <p>')
  .option('-t, --tags <list>', 'comma separated')
  .option('--depends <ids>', 'comma separated task ids')
  .option('--template <name>', `body template: ${TASK_TEMPLATES.join(' or ')} ("agent" has every section an agent needs)`, 'default')
  .option('--json', 'print the created task as JSON')
  .option('--force', 'create the task even if it fails validation')
  .action(async (words: string[], o: Record<string, string | boolean | undefined>) => {
    jsonErrors = !!o.json;
    const template = o.template as TaskTemplate;
    if (!TASK_TEMPLATES.includes(template)) fail(`Unknown template "${template}". Use one of: ${TASK_TEMPLATES.join(', ')}.`);
    const ws = await load();
    const project = o.project ? getProject(ws, o.project as string) : currentProject(ws);
    const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    const priority = o.priority === undefined ? undefined : parseYaml(o.priority as string);
    const status = (o.status as string) ?? project.statuses[0];
    const task = {
      title: words.join(' '),
      status,
      owner: o.owner as string | undefined,
      author: (o.author as string) ?? defaultAuthor(),
      start: o.start as string | undefined,
      // A task created as done ended today, unless told otherwise.
      end: (o.end as string | undefined) ?? (isFinalStatus(project, status) ? today() : undefined),
      priority,
      tags: list(o.tags),
      dependsOn: list(o.depends),
      body: taskBody(words.join(' '), template),
    };
    if (envAgent && isFinalStatus(project, status)) fail(`MDPM_AGENT is "${envAgent}": agents don't create tasks as "${status}". Leave out --status, or use an earlier status.`);
    const target = nextTaskPath(project.dir, task.title, project.taskExtension);
    guard(ws, previewNewTask(ws, project, target, newTaskMeta(task)), o.force as boolean | undefined);
    const file = await createTask(project.dir, task, project.taskExtension);
    if (o.json) {
      const fresh = await loadWorkspace(ws.root);
      return console.log(JSON.stringify(taskJson(fresh, findTask(fresh, file)!), null, 2));
    }
    console.log(`Created ${rel(ws, file)}`);
  });

program
  .command('list')
  .alias('ls')
  .description('list tasks')
  .option('-s, --status <list>', 'comma separated statuses')
  .option('-o, --owner <owner>', 'owner ("-" for unassigned)')
  .option('-p, --project <project>', 'project (includes sub projects)')
  .option('-t, --tag <tag>')
  .option('--json', 'machine readable output')
  .action(async (o: { status?: string; owner?: string; project?: string; tag?: string; json?: boolean }) => {
    const ws = await load();
    const tasks = filterTasks(ws, o);
    if (o.json) return console.log(JSON.stringify(tasks.map((t) => taskJson(ws, t)), null, 2));
    for (const t of tasks) console.log(`${statusText(t.status.padEnd(12))} ${taskLine(ws, t)}`);
    if (!tasks.length) console.log(dim('No tasks.'));
  });

program
  .command('show <task>')
  .description('show a task (by id or path)')
  .option('--json', 'machine readable output (includes body)')
  .action(async (ref: string, o: { json?: boolean }) => {
    const ws = await load();
    const t = getTask(ws, ref);
    if (o.json) return console.log(JSON.stringify({ ...taskJson(ws, t), body: t.body }, null, 2));
    console.log(taskLine(ws, t));
    console.log(dim(`status: ${t.status}   project: ${t.home.name}   file: ${rel(ws, t.file)}`));
    if (t.status === BLOCKED_STATUS) for (const q of openQuestions(t.body)) console.log(yellow(`? ${q}`));
    if (t.dependsOn.length) console.log(dim(`depends on: ${t.dependsOn.join(', ')}`));
    console.log(`\n${t.body.trim()}\n`);
  });

program
  .command('set <task> <assignments...>')
  .description('set front matter fields, e.g. mdpm set login status=done owner=eli tags=ui,auth (empty value deletes)')
  .option('--force', 'write even if the result fails validation')
  .action(async (ref: string, pairs: string[], o: { force?: boolean }) => {
    const ws = await load();
    const t = getTask(ws, ref);
    const changes = applyStatusDefaults(t, parseAssignments(pairs));
    agentCheck(t, changes);
    guard(ws, previewTaskChange(ws, t, changes), o.force);
    await updateTask(t.file, changes);
    console.log(`Updated ${rel(ws, t.file)}`);
  });

program
  .command('move <task> <status>')
  .description('change the status of a task (validated against the project\'s statuses and rules)')
  .option('--force', 'write even if the result fails validation')
  .action(async (ref: string, status: string, o: { force?: boolean }) => {
    const ws = await load();
    const t = getTask(ws, ref);
    const changes = applyStatusDefaults(t, { status });
    agentCheck(t, changes);
    guard(ws, previewTaskChange(ws, t, changes), o.force);
    await updateTask(t.file, changes);
    console.log(`${t.id}: ${t.status} → ${status}`);
  });

program
  .command('link <task> <project>')
  .description('make a task also appear in another project (symlink, no copy)')
  .action(async (ref: string, projectRef: string) => {
    const ws = await load();
    const t = getTask(ws, ref);
    const p = getProject(ws, projectRef);
    if (t.locations.some((l) => l.project === p)) fail(`${t.id} is already in ${p.name}; nothing to do.`);
    const link = await linkTask(t.file, p.dir).catch((e) => fail(e.message));
    console.log(`Linked ${rel(ws, link.path)} → ${rel(ws, t.file)} (${link.kind})`);
    if (link.kind === 'stub') console.log(dim('Symlinks are not permitted here; wrote a path stub instead. Enable Windows Developer Mode for real symlinks.'));
  });

program
  .command('unlink <task> <project>')
  .description('remove a shared task from a project (never deletes the real file)')
  .action(async (ref: string, projectRef: string) => {
    const ws = await load();
    const t = getTask(ws, ref);
    const p = getProject(ws, projectRef);
    const loc = t.locations.find((l) => l.project === p && l.link);
    if (!loc) {
      if (t.home === p) {
        fail(`${p.name} is the home of ${t.id} (the real file lives there), so there is no link to remove. To take it out of ${p.name}, move or delete ${rel(ws, t.file)}.`);
      }
      fail(`${t.id} is not in ${p.name}, so there is nothing to unlink. It appears in: ${t.locations.map((l) => l.project.id).join(', ')}.`);
    }
    await unlinkTask(loc.path);
    console.log(`Removed ${rel(ws, loc.path)}`);
  });

program
  .command('board')
  .description('print a kanban board')
  .option('-p, --project <project>', 'project (includes sub projects)')
  .option('-o, --owner <owner>')
  .action(async (o: { project?: string; owner?: string }) => {
    const ws = await load();
    const project = o.project ? getProject(ws, o.project) : undefined;
    const tasks = filterTasks(ws, o);
    const statuses = project ? [...project.statuses] : [...new Set(ws.projects.flatMap((p) => p.statuses))];
    for (const t of tasks) if (!statuses.includes(t.status)) statuses.push(t.status);
    for (const s of statuses) {
      const col = tasks.filter((t) => t.status === s);
      const heading = bold(s.toUpperCase());
      console.log(`\n${s === BLOCKED_STATUS ? yellow(heading) : heading} ${dim(`(${col.length})`)}`);
      for (const t of col) console.log(`  • ${taskLine(ws, t)}`);
    }
    console.log();
  });

program
  .command('check')
  .description('validate all .proj settings and task front matter; exits 1 on errors (and on warnings with --strict)')
  .option('--strict', 'treat warnings as errors (recommended for CI and agent runs)')
  .option('--task <task>', 'only check this task')
  .option('--hook', 'Claude Code Stop hook: check $MDPM_TASK, and exit 2 (keep the agent working) if it is invalid or has no new log entry, handoff or block')
  .option('--json', 'machine readable output')
  .action(async (o: { json?: boolean; strict?: boolean; task?: string; hook?: boolean }) => {
    if (o.hook) return stopHook(o.task ?? process.env.MDPM_TASK);
    const ws = await load();
    if (o.task) {
      const t = getTask(ws, o.task);
      ws.issues = ws.issues.filter((i) => i.file === t.file);
    }
    const errors = ws.issues.filter((i) => i.level === 'error').length;
    const warnings = ws.issues.length - errors;
    const failed = errors > 0 || (!!o.strict && warnings > 0);
    if (o.json) {
      const issues = ws.issues.map((i) => ({ ...i, file: rel(ws, i.file) }));
      console.log(JSON.stringify({ ok: !failed, errors, warnings, projects: ws.projects.length, tasks: ws.tasks.length, issues }, null, 2));
    } else {
      const sorted = [...ws.issues].sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
      for (const i of sorted) console.log(formatIssue(ws, i));
      const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
      const summary = `${n(ws.projects.length, 'project')}, ${n(ws.tasks.length, 'task')}: ${n(errors, 'error')}, ${n(warnings, 'warning')}`;
      console.log(failed ? red(summary) : dim(summary));
      if (!o.strict && warnings && !errors) console.log(dim('Warnings do not fail the check; use --strict to make them fail too.'));
    }
    if (failed) process.exitCode = 1;
  });

/** Claude Code Stop hook: exit 2 with the reason on stderr keeps the agent going. */
async function stopHook(ref: string | undefined) {
  if (!ref) return; // not an mdpm run
  let input: { stop_hook_active?: boolean } = {};
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      // not JSON: treat as a first stop
    }
  }
  const ws = await loadWorkspace(root());
  const t = findTask(ws, ref);
  if (!t) return;
  const agent = envAgent ?? t.owner ?? '';
  const problems = ws.issues.filter((i) => i.file === t.file && i.level === 'error').map((i) => `${i.message} [${i.code}]`);
  if (lastEntryIsClaim(t, agent)) {
    problems.push(
      `You haven't written anything back to task "${t.id}" yet. Before stopping, run one of: mdpm handoff ${t.id} "<summary>" --branch <branch> (work done), mdpm block ${t.id} "<question>" (need an answer), mdpm log ${t.id} "<progress>" (stopping part way).`,
    );
  }
  if (!problems.length) return;
  if (input.stop_hook_active) {
    // Already asked once; don't trap the agent in a loop. The runner records the state.
    console.error(`mdpm: task "${t.id}" is still not in order: ${problems.join(' ')}`);
    return;
  }
  console.error(`mdpm: task "${t.id}" needs attention before you stop:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(2);
}

/** Validates and writes a write-back, then prints the result. Shared by claim/log/block/handoff/release. */
async function applyWrite(ws: Workspace, t: Task, wb: WriteBack, o: { json?: boolean; force?: boolean }, done: string) {
  guard(ws, previewTaskChange(ws, t, wb.changes, bodyAfter(t, wb)), o.force);
  await writeBack(t.file, wb);
  if (o.json) {
    const fresh = await loadWorkspace(ws.root);
    const after = findTask(fresh, t.file)!;
    return console.log(JSON.stringify({ ok: true, task: taskFields(fresh, after), log: agentLog(after.body).at(-1), questions: openQuestions(after.body) }, null, 2));
  }
  console.log(done);
}

/** Runs a planned write-back, turning protocol refusals into actionable errors. */
function plan(fn: () => WriteBack): WriteBack {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AgentError) fail(e.message);
    throw e;
  }
}

const agentOption = '--agent <name>';
const agentHelp = 'agent name (default: $MDPM_AGENT, else your git user name)';

program
  .command('next')
  .description('the best task for an agent to work on next, and how (resume / implement / refine)')
  .option(agentOption, 'agent name (default: $MDPM_AGENT, else the default agent)')
  .option('--all', 'list every eligible task in order, and why the agent\'s other tasks are skipped')
  .option('--json', 'machine readable output')
  .action(async (o: { agent?: string; all?: boolean; json?: boolean }) => {
    jsonErrors = !!o.json;
    const ws = await load();
    const agent = o.agent?.trim() || envAgent || agentDefinitions(ws).default;
    const { picks, skipped } = agentQueue(ws, agent);
    const pickJson = (p: (typeof picks)[number]) => ({
      mode: p.mode,
      assigned: p.assigned,
      ready: p.readiness.ready,
      verification: p.readiness.verification,
      task: taskFields(ws, p.task),
    });
    if (o.json) {
      const skips = skipped.map((s) => ({ id: s.task.id, reason: s.reason }));
      const out = o.all ? { agent, picks: picks.map(pickJson), skipped: skips } : { agent, next: picks[0] ? { ...pickJson(picks[0]), body: picks[0].task.body } : null, skipped: skips };
      return console.log(JSON.stringify(out, null, 2));
    }
    for (const p of o.all ? picks : picks.slice(0, 1)) {
      console.log(`${bold(p.mode.padEnd(9))} ${taskLine(ws, p.task)} ${dim(p.assigned ? '' : '(unassigned)')}`);
      if (!o.all) console.log(dim(`file: ${rel(ws, p.task.file)}   claim it with: mdpm claim ${p.task.id} --agent ${agent}`));
    }
    if (!picks.length) console.log(dim(`Nothing for ${agent} to do.`));
    if ((o.all || !picks.length) && skipped.length) {
      console.log(dim(`\nSkipped:`));
      for (const s of skipped) console.log(dim(`  ${s.task.id}: ${s.reason}`));
    }
    if (!picks.length && !skipped.length) {
      console.log(dim(`Assign a task with "mdpm set <task> owner=${agent}", or set "agent: {unassigned: true}" in a project's .proj so ${agent} picks unassigned tasks.`));
    }
  });

program
  .command('claim <task>')
  .description('take a task: in-progress and owned by the agent (refinement keeps the status); fails if someone else has it')
  .option(agentOption, agentHelp)
  .option('--run <id>', 'run id to record (default: $MDPM_RUN or a new one)')
  .option('--json', 'machine readable output')
  .option('--force', 'take the task over from its current owner, or write even if it fails validation')
  .action(async (ref: string, o: { agent?: string; run?: string; json?: boolean; force?: boolean }) => {
    jsonErrors = !!o.json;
    const ws = await load();
    const t = getTask(ws, ref);
    const agent = signer(o);
    if (envAgent && agent !== envAgent) fail(`MDPM_AGENT is "${envAgent}", so you can't claim as "${agent}". Drop --agent, or unset MDPM_AGENT.`);
    const wb = plan(() => planClaim(t, agent, o.run ?? process.env.MDPM_RUN ?? runId(), { force: o.force }));
    await applyWrite(ws, t, wb, o, `${t.id}: ${wb.log} by ${agent}`);
  });

program
  .command('log <task> <text...>')
  .description('append a timestamped entry to the task\'s "## Agent log"')
  .option(agentOption, agentHelp)
  .option('--json', 'machine readable output')
  .action(async (ref: string, words: string[], o: { agent?: string; json?: boolean }) => {
    jsonErrors = !!o.json;
    const ws = await load();
    const t = getTask(ws, ref);
    agentCheck(t, {});
    const text = words.join(' ').trim();
    if (!text) fail('Give the text to log, e.g. mdpm log <task> "Parser done; starting on the CLI"');
    await applyWrite(ws, t, { changes: {}, log: text, by: signer(o) }, o, `${t.id}: logged`);
  });

program
  .command('block <task> <questions...>')
  .description('mark a task blocked and add each question under "## Questions"')
  .option(agentOption, agentHelp)
  .option('--json', 'machine readable output')
  .option('--force', 'write even if the result fails validation')
  .action(async (ref: string, questions: string[], o: { agent?: string; json?: boolean; force?: boolean }) => {
    jsonErrors = !!o.json;
    const ws = await load();
    const t = getTask(ws, ref);
    const wb = plan(() => planBlock(t, signer(o), questions));
    agentCheck(t, wb.changes);
    await applyWrite(ws, t, wb, o, `${t.id}: ${t.status} → ${BLOCKED_STATUS} (${questions.length} question${questions.length > 1 ? 's' : ''})`);
  });

program
  .command('handoff <task> <summary...>')
  .description('hand finished work to a person: status review, records branch/pr, logs the summary')
  .option(agentOption, agentHelp)
  .option('--branch <branch>', 'branch with the work')
  .option('--pr <url>', 'pull request URL')
  .option('--json', 'machine readable output')
  .option('--force', 'write even if the result fails validation')
  .action(async (ref: string, words: string[], o: { agent?: string; branch?: string; pr?: string; json?: boolean; force?: boolean }) => {
    jsonErrors = !!o.json;
    const ws = await load();
    const t = getTask(ws, ref);
    const wb = plan(() => planHandoff(t, signer(o), words.join(' '), o));
    agentCheck(t, wb.changes);
    await applyWrite(ws, t, wb, o, `${t.id}: ${t.status} → review`);
  });

program
  .command('release <task> <reason...>')
  .description('give a task back without doing it (status todo, owner unchanged); the agent won\'t pick it again until someone logs on it')
  .option(agentOption, agentHelp)
  .option('--json', 'machine readable output')
  .option('--force', 'write even if the result fails validation')
  .action(async (ref: string, words: string[], o: { agent?: string; json?: boolean; force?: boolean }) => {
    jsonErrors = !!o.json;
    const ws = await load();
    const t = getTask(ws, ref);
    const wb = plan(() => planRelease(t, signer(o), words.join(' ')));
    agentCheck(t, wb.changes);
    await applyWrite(ws, t, wb, o, `${t.id}: ${t.status} → todo (released)`);
  });

const agent = program.command('agent').description('set up and run coding agents (Claude Code, Codex, Cursor, …) on tasks');

agent
  .command('init')
  .description('write the task protocol for agents: .claude/skills/mdpm/SKILL.md and a section of AGENTS.md (re-run to update)')
  .option('--dir <dir>', 'where to write (default: the workspace root)')
  .option('--claude-hook', 'also add a Claude Code Stop hook that keeps the agent working until its task is written back')
  .action(async (o: { dir?: string; claudeHook?: boolean }) => {
    const dir = path.resolve(o.dir ?? root());
    const results = await agentInit(dir, { claudeHook: o.claudeHook }).catch((e) => fail(e.message));
    for (const r of results) console.log(`${r.action.padEnd(9)} ${toPosix(path.relative(process.cwd(), r.file)) || r.file}`);
  });

agent
  .command('run')
  .description('pick the next task (or --task), claim it, and run the agent on it in a git worktree on branch agent/<task-id>')
  .option(agentOption, 'agent to run (default: agents.default in the root .proj, else claude)')
  .option('--task <task>', 'run this task instead of picking one')
  .option('--max-tasks <n>', 'stop after this many tasks', '1')
  .option('--max-turns <n>', 'turn limit per task (default: agent.maxTurns, 50)')
  .option('--dry-run', 'print the task, command and prompt; change nothing')
  .action(async (o: { agent?: string; task?: string; maxTasks: string; maxTurns?: string; dryRun?: boolean }) => {
    const int = (v: string | undefined, flag: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) fail(`${flag} must be a whole number above 0, got "${v}".`);
      return n;
    };
    if (envAgent) fail(`MDPM_AGENT is set ("${envAgent}"), so this looks like an agent starting another agent. Agents can't run "mdpm agent run"; unset MDPM_AGENT if you are a person.`);
    const ws = await load();
    try {
      const summary = await runAgents({
        root: ws.root,
        agent: o.agent,
        task: o.task,
        maxTasks: int(o.maxTasks, '--max-tasks'),
        maxTurns: int(o.maxTurns, '--max-turns'),
        dryRun: o.dryRun,
        cli: { node: process.execPath, script: path.resolve(process.argv[1]) },
        log: (m) => console.log(m),
      });
      console.log(dim(summary.stopped));
    } catch (e) {
      if (e instanceof RunnerError) fail(e.message);
      throw e;
    }
  });

agent
  .command('status')
  .description('agents working right now, and the tasks queued for them')
  .option('--json', 'machine readable output')
  .action(async (o: { json?: boolean }) => {
    const ws = await load();
    const queued = ws.tasks.filter((t) => t.owner && agentDefinitions(ws).agents[t.owner] && ['backlog', 'todo'].includes(t.status) && !runningOn(t));
    if (o.json) {
      return console.log(JSON.stringify({ running: activeRuns, queued: queued.map((t) => ({ id: t.id, owner: t.owner, status: t.status })) }, null, 2));
    }
    for (const r of activeRuns) console.log(`${green('⚙')} ${bold(r.task)}  ${runningText(r)}  ${dim(`pid ${r.pid}, run ${r.run}`)}`);
    if (!activeRuns.length) console.log(dim('No agent is working right now.'));
    if (queued.length) console.log(dim(`\nQueued: ${queued.map((t) => `${t.id} (${t.owner})`).join(', ')}`));
  });

agent
  .command('continue <task>')
  .description('talk to the agent that worked on a task: reopens its conversation (or starts one from the task) in the task\'s worktree')
  .option(agentOption, 'agent to talk to (default: the agent of the last run on the task)')
  .option('--fresh', 'start a new conversation instead of reopening the last one')
  .option('--dry-run', 'print what would run; change nothing')
  .action(async (ref: string, o: { agent?: string; fresh?: boolean; dryRun?: boolean }) => {
    if (envAgent) fail(`MDPM_AGENT is set ("${envAgent}"), so this looks like an agent starting a session. "mdpm agent continue" is for people; unset MDPM_AGENT if you are one.`);
    const ws = await load();
    let plan;
    try {
      plan = await planContinue({ root: ws.root, task: ref, agent: o.agent, fresh: o.fresh, dryRun: o.dryRun, cli: { node: process.execPath, script: path.resolve(process.argv[1]) } });
    } catch (e) {
      if (e instanceof RunnerError) fail(e.message);
      throw e;
    }
    const what = plan.reopened ? `reopening ${plan.agent}'s last conversation` : `starting a new ${plan.agent} conversation from the task`;
    console.log(`${bold(plan.task.title)} ${dim(`[${plan.task.id}, ${plan.task.status}]`)}: ${what} in ${plan.worktree}${plan.recreated ? dim(` (worktree recreated on ${plan.branch})`) : ''}`);
    if (o.dryRun) {
      console.log(dim(plan.command.map((a) => (/\s/.test(a) ? JSON.stringify(a.length > 80 ? a.slice(0, 80) + '…' : a) : a)).join(' ')));
      return;
    }
    await writeBack(plan.task.file, { changes: {}, log: `${plan.reopened ? 'reopened' : 'started'} an interactive ${plan.agent} session on this task`, by: defaultAuthor() });
    process.exitCode = (await runInteractive(plan)) ?? 1;
  });

program
  .command('where')
  .description('print the folder that is scanned and the projects found')
  .action(async () => {
    const ws = await loadWorkspace(root());
    console.log(ws.root);
    for (const p of ws.projects) console.log(dim(`  ${p.id}  ${projectSubtree(p).length - 1} sub projects`));
  });

// Always read argv the node way: under VS Code's runtime (Electron, ELECTRON_RUN_AS_NODE) commander would otherwise treat the script path as the first argument.
program.parseAsync(process.argv, { from: 'node' }).catch((e) => fail(e instanceof Error ? e.message : String(e)));
