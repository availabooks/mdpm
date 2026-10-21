import {
  ActiveRun,
  AgentError,
  BLOCKED_STATUS,
  FLOW_STAGES,
  FLOW_STAGE_INFO,
  Issue,
  MARKER_END,
  Project,
  RunnerError,
  STATUSES,
  Task,
  WriteBack,
  Workspace,
  activityVerb,
  agentDefinitions,
  agentGuard,
  agentInit,
  ago,
  applyMigration,
  bodyAfter,
  branchExists,
  createProject,
  createTask,
  defaultAuthor,
  describeStatus,
  findProject,
  findRoot,
  findTask,
  flowQueue,
  flowStage,
  gitRoot,
  ideaBody,
  lastEntryIsStart,
  linkTask,
  loadActive,
  loadWorkspace,
  logEntries,
  needsPerson,
  newTaskMeta,
  nextTaskPath,
  openQuestions,
  planAccept,
  planApprove,
  planBlock,
  planContinue,
  planHandoff,
  planMigration,
  planMove,
  planPropose,
  planRework,
  planStart,
  planUnblock,
  previewNewTask,
  previewTaskChange,
  projectSubtree,
  runAgents,
  runInteractive,
  slotHolder,
  suggest,
  tasksInProject,
  toPosix,
  unlinkTask,
  updateTask,
  writeBack,
} from '@mdpm/core';
import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

const LIST_KEYS = new Set(['tags']);
/** Front matter the flow commands own; `mdpm set` refuses them. */
const FLOW_FIELDS: Record<string, string> = {
  status: 'mdpm move <idea> <status>, or the flow commands (propose, approve, start, block, unblock, handoff, rework, accept)',
  approved: 'mdpm approve <idea>',
  blocked_from: 'mdpm block / mdpm unblock',
  completed: 'mdpm accept <idea>',
};
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);

const program = new Command()
  .name('mdpm')
  .description('An AI flow in your repo: idea → plan → executing → review → done, as markdown files')
  .version('0.1.0')
  .option('-r, --root <dir>', 'folder to scan (default: $MDPM_ROOT, git root, or topmost .proj)');

function root(): string {
  const opt = program.opts().root as string | undefined;
  return opt ? path.resolve(opt) : findRoot(process.cwd());
}

/** Agents working right now, loaded with the workspace; shown next to their ideas. */
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
        `  • If your ideas live elsewhere, run with --root <folder> or set MDPM_ROOT.`,
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

/** Refuses commands an agent isn't allowed to run (see agentGuard). No-op for people. */
function agentCheck(command: string, t: Task) {
  if (!envAgent) return;
  const why = agentGuard(command, t, envAgent, process.env.MDPM_TASK?.trim() || undefined);
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

function statusText(t: Task): string {
  const s = t.status === 'plan' && t.approved ? 'plan ✓' : t.status;
  return t.status === BLOCKED_STATUS ? yellow(s) : s;
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
  fail(`No idea with id or path "${ref}".${hint ? ` Did you mean "${hint}"?` : ''} Run "mdpm list" to see idea ids.`);
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
    stage: flowStage(t),
    approved: t.approved,
    blocked_from: t.blockedFrom,
    author: t.author,
    created: t.created,
    completed: t.completed,
    priority: t.priority,
    tags: t.tags,
    file: rel(ws, t.file),
    project: t.home.id,
    projects: t.locations.map((l) => ({ project: l.project.id, path: rel(ws, l.path), link: l.link })),
    branch: t.branch,
    pr: t.pr,
    waiting_on_you: needsPerson(t),
    running: runningOn(t) && { agent: runningOn(t)!.agent, mode: runningOn(t)!.mode, since: runningOn(t)!.started },
  };
}

function taskLine(ws: Workspace, t: Task): string {
  const bits = [
    bold(t.title),
    dim(`[${t.id}]`),
    t.priority !== undefined ? `p:${t.priority}` : '',
    t.branch && ['executing', 'review'].includes(flowStage(t)) ? dim(`⎇ ${t.branch}`) : '',
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
    if (i < 1) fail(`Expected key=value (e.g. priority=1), got "${pair}". To delete a field, leave the value empty (e.g. tags=).`);
    const key = pair.slice(0, i).trim();
    const raw = pair.slice(i + 1).trim();
    if (FLOW_FIELDS[key]) fail(`"${key}" belongs to the flow, so "mdpm set" doesn't change it. Use ${FLOW_FIELDS[key]}.`);
    if (raw === '') changes[key] = null;
    else if (LIST_KEYS.has(key) && !raw.startsWith('[')) changes[key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    else {
      const v = parseYaml(raw);
      changes[key] = v === null ? raw : v;
    }
  }
  return changes;
}

function filterTasks(ws: Workspace, opts: { status?: string; project?: string; tag?: string }): Task[] {
  let tasks = opts.project ? tasksInProject(ws, getProject(ws, opts.project)) : ws.tasks;
  if (opts.status) {
    const wanted = new Set(opts.status.split(',').map((s) => s.trim()));
    const unknown = [...wanted].filter((s) => !(STATUSES as readonly string[]).includes(s));
    if (unknown.length) fail(`Unknown status ${unknown.map((s) => `"${s}"`).join(', ')}. The statuses are ${STATUSES.join(', ')}.`);
    tasks = tasks.filter((t) => wanted.has(t.status));
  }
  if (opts.tag) tasks = tasks.filter((t) => t.tags.includes(opts.tag!));
  return tasks;
}

program
  .command('init [dir]')
  .description('create a root project (.proj) in dir (default: ./tasks)')
  .option('-n, --name <name>', 'project name')
  .action(async (dir: string | undefined, o: { name?: string }) => {
    const target = path.resolve(dir ?? 'tasks');
    const file = await createProject(target, {
      name: o.name ?? path.basename(path.resolve(target, dir ? '.' : '..')),
      description: '',
      owner: defaultAuthor(),
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
      const out = ws.projects.map((p) => ({ id: p.id, name: p.name, parent: p.parent?.id, ideas: tasksInProject(ws, p, false).length, meta: p.meta }));
      return console.log(JSON.stringify(out, null, 2));
    }
    const print = (p: Project, depth: number) => {
      const count = tasksInProject(ws, p, false).length;
      console.log(`${'  '.repeat(depth)}${bold(p.name)} ${dim(`${p.id}  (${count} ideas)`)}`);
      p.children.forEach((c) => print(c, depth + 1));
    };
    ws.projects.filter((p) => !p.parent).forEach((p) => print(p, 0));
  });

program
  .command('idea <title...>')
  .description('write down a new idea (status idea); the agent plans it')
  .option('-p, --project <project>', 'project id/path/name (default: project containing cwd)')
  .option('-a, --author <author>', 'default: git user.name')
  .option('--priority <p>', 'lower is sooner, e.g. 1, or high/medium/low')
  .option('-t, --tags <list>', 'comma separated')
  .option('--json', 'print the created idea as JSON')
  .option('--force', 'create the idea even if it fails validation')
  .action(async (words: string[], o: Record<string, string | boolean | undefined>) => {
    jsonErrors = !!o.json;
    const ws = await load();
    const project = o.project ? getProject(ws, o.project as string) : currentProject(ws);
    const title = words.join(' ').trim();
    if (!title) fail('Give the idea a title, e.g. mdpm idea "Export the board as CSV"');
    const task = {
      title,
      status: 'idea',
      author: (o.author as string) ?? defaultAuthor(),
      priority: o.priority === undefined ? undefined : parseYaml(o.priority as string),
      tags: typeof o.tags === 'string' ? o.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      body: ideaBody(title),
    };
    const target = nextTaskPath(project.dir, task.title, project.taskExtension);
    guard(ws, previewNewTask(ws, project, target, newTaskMeta(task)), o.force as boolean | undefined);
    const file = await createTask(project.dir, task, project.taskExtension);
    if (o.json) {
      const fresh = await loadWorkspace(ws.root);
      return console.log(JSON.stringify(taskJson(fresh, findTask(fresh, file)!), null, 2));
    }
    console.log(`Created ${rel(ws, file)}. Write what you want under "## Idea"; the agent plans it on its next run.`);
  });

program
  .command('new', { hidden: true })
  .allowUnknownOption()
  .argument('[words...]')
  .action(() => fail('"mdpm new" is now "mdpm idea <title>": mdpm works with ideas that the agent plans and builds. See "mdpm idea --help".'));

program
  .command('list')
  .alias('ls')
  .description('list ideas')
  .option('-s, --status <list>', `comma separated statuses (${STATUSES.join(', ')})`)
  .option('-p, --project <project>', 'project (includes sub projects)')
  .option('-t, --tag <tag>')
  .option('--json', 'machine readable output')
  .action(async (o: { status?: string; project?: string; tag?: string; json?: boolean }) => {
    const ws = await load();
    const tasks = filterTasks(ws, o);
    if (o.json) return console.log(JSON.stringify(tasks.map((t) => taskJson(ws, t)), null, 2));
    const order = (t: Task) => FLOW_STAGES.indexOf(flowStage(t));
    for (const t of [...tasks].sort((a, b) => order(a) - order(b))) console.log(`${statusText(t).padEnd(color && t.status === BLOCKED_STATUS ? 21 : 12)} ${taskLine(ws, t)}`);
    if (!tasks.length) console.log(dim('No ideas.'));
  });

program
  .command('show <idea>')
  .description('show an idea (by id or path)')
  .option('--json', 'machine readable output (includes body)')
  .action(async (ref: string, o: { json?: boolean }) => {
    const ws = await load();
    const t = getTask(ws, ref);
    if (o.json) return console.log(JSON.stringify({ ...taskJson(ws, t), body: t.body }, null, 2));
    console.log(taskLine(ws, t));
    console.log(dim(`${describeStatus(t)}   project: ${t.home.name}   file: ${rel(ws, t.file)}${t.pr ? `   pr: ${t.pr}` : ''}`));
    if (t.status === BLOCKED_STATUS) for (const q of openQuestions(t.body)) console.log(yellow(`? ${q}`));
    console.log(`\n${t.body.trim()}\n`);
  });

program
  .command('set <idea> <assignments...>')
  .description('set other front matter fields, e.g. mdpm set login priority=1 tags=ui,auth title="Log in" (empty value deletes); the status moves with the flow commands')
  .option('--force', 'write even if the result fails validation')
  .action(async (ref: string, pairs: string[], o: { force?: boolean }) => {
    const ws = await load();
    const t = getTask(ws, ref);
    agentCheck('set', t);
    const changes = parseAssignments(pairs);
    guard(ws, previewTaskChange(ws, t, changes), o.force);
    await updateTask(t.file, changes);
    console.log(`Updated ${rel(ws, t.file)}`);
  });

program
  .command('link <idea> <project>')
  .description('make an idea also appear in another project (symlink, no copy)')
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
  .command('unlink <idea> <project>')
  .description('remove a shared idea from a project (never deletes the real file)')
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
  .description('print the flow board: idea → plan → executing → review → done')
  .option('-p, --project <project>', 'project (includes sub projects)')
  .action(async (o: { project?: string }) => {
    const ws = await load();
    const tasks = filterTasks(ws, o);
    const slot = slotHolder(ws);
    console.log(dim(slot ? `Execution slot: ${slot.id} (${describeStatus(slot)})` : 'Execution slot: free'));
    const waiting = tasks.filter(needsPerson).length;
    if (waiting) console.log(yellow(`${waiting} waiting on you`));
    for (const s of FLOW_STAGES) {
      const col = tasks.filter((t) => flowStage(t) === s);
      console.log(`\n${bold(FLOW_STAGE_INFO[s].label.toUpperCase())} ${dim(`(${col.length})`)}`);
      for (const t of col) {
        const flag = t.status === BLOCKED_STATUS ? yellow(' ⚠ needs your answer') : t.status === 'plan' ? (t.approved ? dim(' ✓ approved') : yellow(' awaiting approval')) : t.status === 'review' ? yellow(' to review') : '';
        console.log(`  • ${taskLine(ws, t)}${flag}`);
      }
    }
    console.log();
  });

program
  .command('check')
  .description('validate all .proj settings and idea front matter; exits 1 on errors (and on warnings with --strict)')
  .option('--strict', 'treat warnings as errors (recommended for CI and agent runs)')
  .option('--task <idea>', 'only check this idea')
  .option('--hook', 'Claude Code Stop hook: check $MDPM_TASK, and exit 2 (keep the agent working) if it is invalid or has nothing written back since the run started')
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
      console.log(JSON.stringify({ ok: !failed, errors, warnings, projects: ws.projects.length, ideas: ws.tasks.length, issues }, null, 2));
    } else {
      const sorted = [...ws.issues].sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
      for (const i of sorted) console.log(formatIssue(ws, i));
      const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
      const summary = `${n(ws.projects.length, 'project')}, ${n(ws.tasks.length, 'idea')}: ${n(errors, 'error')}, ${n(warnings, 'warning')}`;
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
  const agent = envAgent ?? '';
  const problems = ws.issues.filter((i) => i.file === t.file && i.level === 'error').map((i) => `${i.message} [${i.code}]`);
  if (lastEntryIsStart(t, agent)) {
    const finish = t.status === 'idea' ? `mdpm propose ${t.id} "<summary>" (plan written)` : `mdpm handoff ${t.id} "<summary>" (work done)`;
    problems.push(`You haven't written anything back to idea "${t.id}" yet. Before stopping, run one of: ${finish}, mdpm block ${t.id} "<question>" (need an answer), mdpm log ${t.id} "<progress>" (stopping part way).`);
  }
  if (!problems.length) return;
  if (input.stop_hook_active) {
    // Already asked once; don't trap the agent in a loop. The runner records the state.
    console.error(`mdpm: idea "${t.id}" is still not in order: ${problems.join(' ')}`);
    return;
  }
  console.error(`mdpm: idea "${t.id}" needs attention before you stop:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  process.exit(2);
}

/** Validates and writes a write-back, then prints the result. Shared by the flow commands. */
async function applyWrite(ws: Workspace, t: Task, wb: WriteBack, o: { json?: boolean; force?: boolean }, done: string) {
  guard(ws, previewTaskChange(ws, t, wb.changes, bodyAfter(t, wb)), o.force);
  await writeBack(t.file, wb);
  if (o.json) {
    const fresh = await loadWorkspace(ws.root);
    const after = findTask(fresh, t.file)!;
    return console.log(JSON.stringify({ ok: true, idea: taskFields(fresh, after), log: logEntries(after.body).at(-1), questions: openQuestions(after.body) }, null, 2));
  }
  console.log(done);
}

/** Runs a planned write-back, turning flow refusals into actionable errors. */
function plan(fn: () => WriteBack): WriteBack {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AgentError) fail(e.message);
    throw e;
  }
}

const agentOption = '--agent <name>';
const agentHelp = 'who signs the log entry (default: $MDPM_AGENT, else your git user name)';

/** Defines a flow command: load, find the idea, check the agent guard rails, plan the write-back, write it. */
function flowCommand(
  name: string,
  args: string,
  description: string,
  build: (ws: Workspace, t: Task, by: string, rest: string[], o: Record<string, string | boolean | undefined>) => WriteBack,
  done: (t: Task, wb: WriteBack) => string,
  configure: (c: Command) => Command = (c) => c,
) {
  configure(
    program
      .command(`${name} <idea> ${args}`.trim())
      .description(description)
      .option(agentOption, agentHelp)
      .option('--json', 'machine readable output')
      .option('--force', 'write even if the result fails validation'),
  ).action(async (ref: string, ...rest: unknown[]) => {
    // Commander passes the declared arguments (a string, or an array for "<x...>"), then the options.
    const at = rest.findIndex((r) => !!r && typeof r === 'object' && !Array.isArray(r));
    const o = (rest[at] ?? {}) as Record<string, string | boolean | undefined>;
    const words = rest.slice(0, at < 0 ? rest.length : at).flat().filter((w): w is string => typeof w === 'string');
    jsonErrors = !!o.json;
    const ws = await load();
    const t = getTask(ws, ref);
    agentCheck(name, t);
    const wb = plan(() => build(ws, t, signer(o as { agent?: string }), words, o));
    if (!Object.keys(wb.changes).length && !wb.log) return console.log(`${t.id}: already ${t.status}; nothing to do.`);
    await applyWrite(ws, t, wb, o, done(t, wb));
  });
}

const to = (wb: WriteBack, t: Task) => `${t.status} → ${(wb.changes.status as string | undefined) ?? t.status}`;

flowCommand('propose', '[summary...]', 'the plan is written: idea → plan, waiting for approval (needs acceptance criteria)', (_ws, t, by, w) => planPropose(t, by, w.join(' ')), (t, wb) => `${t.id}: ${to(wb, t)}. It waits for approval: mdpm approve ${t.id}`);

flowCommand('approve', '', 'approve the plan; it joins the execution queue', (_ws, t, by) => planApprove(t, by), (t) => {
  const open = openQuestions(t.body);
  if (open.length) console.warn(yellow(`warning: "${t.id}" still has ${open.length} open question${open.length > 1 ? 's' : ''}; the agent will read them as they are.`));
  return `${t.id}: approved; it is in the execution queue (mdpm next --all)`;
});

flowCommand(
  'start',
  '',
  'take the execution slot for an approved plan: executing, on branch idea/<id> (one idea at a time)',
  (ws, t, by, _w, o) => planStart(ws, t, by, (o.run as string | undefined) ?? process.env.MDPM_RUN),
  (t, wb) => `${t.id}: ${to(wb, t)} on ${(wb.changes.branch as string | undefined) ?? t.branch}`,
  (c) => c.option('--run <id>', 'run id to record (default: $MDPM_RUN)'),
);

flowCommand('block', '<questions...>', 'blocked until the person answers; each question goes under "## Questions"', (_ws, t, by, w) => planBlock(t, by, w), (t, wb) => `${t.id}: ${to(wb, t)} (${wb.questions?.length} question${wb.questions?.length === 1 ? '' : 's'})`);

flowCommand('unblock', '[answer...]', 'the questions are answered: back to where it was blocked from (ticks the questions, logs the answer)', (ws, t, by, w) => planUnblock(ws, t, by, w.join(' ')), (t, wb) => `${t.id}: ${to(wb, t)}`);

flowCommand(
  'handoff',
  '<summary...>',
  'the work is done: executing → review; records the branch and pull request',
  (_ws, t, by, w, o) => planHandoff(t, by, w.join(' '), { branch: o.branch as string | undefined, pr: o.pr as string | undefined }),
  (t, wb) => `${t.id}: ${to(wb, t)}`,
  (c) => c.option('--branch <branch>', 'branch with the work (default: the idea\'s branch)').option('--pr <url>', 'pull request URL'),
);

flowCommand('rework', '<feedback...>', 'send reviewed work back: review → approved plan, at the front of the queue, on the same branch', (_ws, t, by, w) => planRework(t, by, w.join(' ')), (t, wb) => `${t.id}: ${to(wb, t)}; it is executed next, on ${t.branch ?? 'its branch'}`);

flowCommand('accept', '', 'accept reviewed work: review → done', (_ws, t, by) => planAccept(t, by), (t, wb) => `${t.id}: ${to(wb, t)}`);

flowCommand('move', '<status>', `move an idea to any status (${STATUSES.filter((s) => s !== BLOCKED_STATUS).join(', ')}); the escape hatch, still one idea executing at a time`, (ws, t, by, w) => planMove(ws, t, w[0] ?? '', by), (t, wb) => `${t.id}: ${to(wb, t)}`);

program
  .command('log <idea> <text...>')
  .description('append a timestamped entry to the idea\'s "## Log"')
  .option(agentOption, agentHelp)
  .option('--json', 'machine readable output')
  .action(async (ref: string, words: string[], o: { agent?: string; json?: boolean }) => {
    jsonErrors = !!o.json;
    const ws = await load();
    const t = getTask(ws, ref);
    agentCheck('log', t);
    const text = words.join(' ').trim();
    if (!text) fail('Give the text to log, e.g. mdpm log <idea> "Parser done; starting on the CLI"');
    await applyWrite(ws, t, { changes: {}, log: text, by: signer(o) }, o, `${t.id}: logged`);
  });

program
  .command('next')
  .description('what the agent does next: execute the idea in the slot or the top approved plan, else plan the top idea')
  .option('--all', 'list the whole queue, and why the other ideas wait')
  .option('--json', 'machine readable output')
  .action(async (o: { all?: boolean; json?: boolean }) => {
    jsonErrors = !!o.json;
    const ws = await load();
    const { picks, skipped, slot } = flowQueue(ws);
    const pickJson = (p: (typeof picks)[number]) => ({ mode: p.mode, resume: p.resume, plan_complete: p.plan.complete, verification: p.plan.verification, idea: taskFields(ws, p.task) });
    if (o.json) {
      const skips = skipped.map((s) => ({ id: s.task.id, reason: s.reason }));
      const base = { slot: slot?.id ?? null, skipped: skips };
      const out = o.all ? { ...base, picks: picks.map(pickJson) } : { ...base, next: picks[0] ? { ...pickJson(picks[0]), body: picks[0].task.body } : null };
      return console.log(JSON.stringify(out, null, 2));
    }
    for (const p of o.all ? picks : picks.slice(0, 1)) {
      const mode = p.mode === 'execute' ? (p.resume ? 'resume' : 'execute') : 'plan';
      console.log(`${bold(mode.padEnd(8))} ${taskLine(ws, p.task)}`);
      if (!o.all) {
        const how = p.mode === 'plan' ? `write the plan into it, then: mdpm propose ${p.task.id} "<summary>"` : p.resume ? 'continue it, then: mdpm handoff' : `take it with: mdpm start ${p.task.id}`;
        console.log(dim(`file: ${rel(ws, p.task.file)}   ${how}`));
      }
    }
    if (!picks.length) console.log(dim('Nothing for the agent to do.'));
    if ((o.all || !picks.length) && skipped.length) {
      console.log(dim(`\nWaiting:`));
      for (const s of skipped) console.log(dim(`  ${s.task.id}: ${s.reason}`));
    }
    if (!picks.length && !skipped.length) console.log(dim('Write an idea with "mdpm idea <title>"; the agent plans it on its next run.'));
  });

program
  .command('migrate')
  .description('move a task-based workspace to the flow: map statuses, drop task-era fields and settings, rename sections (dry run unless --write)')
  .option('--write', 'apply the changes')
  .option('--json', 'machine readable output')
  .action(async (o: { write?: boolean; json?: boolean }) => {
    jsonErrors = !!o.json;
    const ws = await loadWorkspace(root());
    if (!ws.projects.length) fail(`No projects found under ${ws.root}, so there is nothing to migrate.`);
    const repo = gitRoot(ws.root);
    const plan = planMigration(ws, { branchExists: repo ? (b) => branchExists(repo, b) : undefined });
    if (o.json && !o.write) return console.log(JSON.stringify({ ...plan, ideas: plan.ideas.map((i) => ({ ...i, file: rel(ws, i.file) })), projects: plan.projects.map((p) => ({ ...p, file: rel(ws, p.file) })) }, null, 2));
    for (const p of plan.projects) console.log(`${bold(rel(ws, p.file))}  ${dim(`remove ${p.removed.join(', ')}`)}`);
    for (const i of plan.ideas) {
      const fields = Object.entries(i.changes)
        .filter(([k]) => k !== 'status')
        .map(([k, v]) => (v === null ? `-${k}` : `${k}: ${v}`));
      const extra = [...fields, ...i.renames.map(([a, b]) => `## ${a} → ## ${b}`)].join(', ');
      console.log(`${i.from === i.to ? i.to.padEnd(24) : `${i.from} → ${i.to}`.padEnd(24)} ${bold(i.id)}  ${dim(extra)}`);
      for (const n of i.notes) console.log(dim(`${' '.repeat(25)}${n}`));
    }
    for (const p of plan.problems) console.log(red(`skipped ${rel(ws, p.file)}: ${p.message}`));
    if (!plan.ideas.length && !plan.projects.length) return console.log(dim('Nothing to migrate: the workspace already uses the flow.'));
    if (!o.write) return console.log(dim(`\nDry run: nothing was changed. Run "mdpm migrate --write" to apply ${plan.ideas.length} idea and ${plan.projects.length} project change${plan.projects.length === 1 ? '' : 's'}.`));
    await applyMigration(plan);
    // Regenerate the protocol only where `mdpm agent init` wrote it before.
    const agentsMd = path.join(ws.root, 'AGENTS.md');
    const initialized = existsSync(path.join(ws.root, '.claude', 'skills', 'mdpm', 'SKILL.md')) || (existsSync(agentsMd) && readFileSync(agentsMd, 'utf8').includes(MARKER_END));
    const marked = initialized ? await agentInit(ws.root).catch(() => []) : [];
    for (const r of marked.filter((r) => r.action !== 'unchanged')) console.log(`${r.action.padEnd(9)} ${rel(ws, r.file)}`);
    const after = await loadWorkspace(ws.root);
    const errors = after.issues.filter((i) => i.level === 'error');
    console.log(green(`\nMigrated ${plan.ideas.length} ideas and ${plan.projects.length} projects.`) + (errors.length ? red(` ${errors.length} errors remain; run "mdpm check".`) : dim(' Run "mdpm board" to see the flow.')));
    if (errors.length) process.exitCode = 1;
  });

const agent = program.command('agent').description('set up and run coding agents (Claude Code, Codex, Cursor, …) on the flow');

agent
  .command('init')
  .description('write the flow protocol for agents: .claude/skills/mdpm/SKILL.md and a section of AGENTS.md (re-run to update)')
  .option('--dir <dir>', 'where to write (default: the workspace root)')
  .option('--claude-hook', 'also add a Claude Code Stop hook that keeps the agent working until it has written back to its idea')
  .action(async (o: { dir?: string; claudeHook?: boolean }) => {
    const dir = path.resolve(o.dir ?? root());
    const results = await agentInit(dir, { claudeHook: o.claudeHook }).catch((e) => fail(e.message));
    for (const r of results) console.log(`${r.action.padEnd(9)} ${toPosix(path.relative(process.cwd(), r.file)) || r.file}`);
  });

agent
  .command('run')
  .description('do the next thing in the flow (execute the idea in the slot or the top approved plan, else plan the top idea) in the agent worktree')
  .option(agentOption, 'agent to run (default: agents.default in the root .proj, else claude)')
  .option('--idea <idea>', 'plan or execute this idea instead of picking one')
  .option('--until-idle', 'keep going, one idea at a time, until nothing is left or usage runs out')
  .option('--max-turns <n>', 'turn limit per run (default: agent.maxTurns, 50)')
  .option('--dry-run', 'print the idea, command and prompt; change nothing')
  .action(async (o: { agent?: string; idea?: string; untilIdle?: boolean; maxTurns?: string; dryRun?: boolean }) => {
    let maxTurns: number | undefined;
    if (o.maxTurns !== undefined) {
      maxTurns = Number(o.maxTurns);
      if (!Number.isInteger(maxTurns) || maxTurns < 1) fail(`--max-turns must be a whole number above 0, got "${o.maxTurns}".`);
    }
    if (envAgent) fail(`MDPM_AGENT is set ("${envAgent}"), so this looks like an agent starting another agent. Agents can't run "mdpm agent run"; unset MDPM_AGENT if you are a person.`);
    const ws = await load();
    try {
      const summary = await runAgents({
        root: ws.root,
        agent: o.agent,
        idea: o.idea,
        untilIdle: o.untilIdle,
        maxTurns,
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
  .description('what the agent is doing now, what holds the execution slot, and what it does next')
  .option('--json', 'machine readable output')
  .action(async (o: { json?: boolean }) => {
    const ws = await load();
    const { picks, slot } = flowQueue(ws);
    const next = picks[0];
    const waiting = ws.tasks.filter(needsPerson);
    if (o.json) {
      return console.log(
        JSON.stringify({ running: activeRuns, slot: slot?.id ?? null, next: next ? { id: next.task.id, mode: next.mode, resume: next.resume } : null, waiting_on_you: waiting.map((t) => ({ id: t.id, status: t.status })) }, null, 2),
      );
    }
    for (const r of activeRuns) console.log(`${green('⚙')} ${bold(r.task)}  ${runningText(r)}  ${dim(`pid ${r.pid}, run ${r.run}`)}`);
    if (!activeRuns.length) console.log(dim('No agent is working right now.'));
    console.log(dim(slot ? `Execution slot: ${slot.id} (${describeStatus(slot)})` : 'Execution slot: free'));
    if (next) console.log(dim(`Next run: ${next.mode === 'plan' ? 'plan' : next.resume ? 'resume' : 'execute'} ${next.task.id}`));
    if (waiting.length) console.log(yellow(`Waiting on you: ${waiting.map((t) => `${t.id} (${describeStatus(t)})`).join(', ')}`));
  });

agent
  .command('continue <idea>')
  .description('talk to the agent about an idea: reopens its last run on the idea (or starts a conversation from the idea) in the agent worktree, on the idea\'s branch')
  .option(agentOption, 'agent to talk to (default: the agent of the last run on the idea)')
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
    const what = plan.reopened ? `reopening ${plan.agent}'s last run on it` : `starting a new ${plan.agent} conversation from the idea`;
    console.log(`${bold(plan.task.title)} ${dim(`[${plan.task.id}, ${describeStatus(plan.task)}]`)}: ${what} in ${plan.worktree} on ${plan.branch}`);
    if (o.dryRun) {
      console.log(dim(plan.command.map((a) => (/\s/.test(a) ? JSON.stringify(a.length > 80 ? a.slice(0, 80) + '…' : a) : a)).join(' ')));
      return;
    }
    await writeBack(plan.task.file, { changes: {}, log: `${plan.reopened ? 'reopened' : 'started'} an interactive ${plan.agent} session on this idea`, by: defaultAuthor() });
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
