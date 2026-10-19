import {
  Project,
  Task,
  Workspace,
  createProject,
  createTask,
  defaultAuthor,
  findProject,
  findRoot,
  findTask,
  linkTask,
  loadWorkspace,
  projectSubtree,
  suggest,
  tasksInProject,
  toPosix,
  unlinkTask,
  updateTask,
} from '@mdpm/core';
import { Command } from 'commander';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

const LIST_KEYS = new Set(['tags', 'depends_on']);
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
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

async function load(): Promise<Workspace> {
  const ws = await loadWorkspace(root());
  if (!ws.projects.length) {
    fail(
      `No projects found under ${ws.root} (a project is a folder containing a .proj file).\n` +
        `  • To start one here, run: mdpm init        (creates ./tasks/.proj)\n` +
        `  • If your tasks live elsewhere, run with --root <folder> or set MDPM_ROOT.`,
    );
  }
  return ws;
}

function fail(msg: string): never {
  console.error(red(`error: ${msg}`));
  process.exit(1);
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
    meta: t.meta,
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
      statuses: o.statuses ? o.statuses.split(',').map((s) => s.trim()) : ['backlog', 'todo', 'in-progress', 'review', 'done'],
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
  .option('--json', 'print the created task as JSON')
  .action(async (words: string[], o: Record<string, string | boolean | undefined>) => {
    const ws = await load();
    const project = o.project ? getProject(ws, o.project as string) : currentProject(ws);
    const status = (o.status as string) ?? project.statuses[0];
    if (!project.statuses.includes(status)) {
      console.warn(
        yellow(
          `warning: "${status}" is not a status of ${project.name} (${project.statuses.join(', ')}). The task is created anyway; ` +
            `fix it with "mdpm move <id> <status>", or add "${status}" to "statuses" in ${rel(ws, project.file)}.`,
        ),
      );
    }
    const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    const priority = o.priority === undefined ? undefined : parseYaml(o.priority as string);
    const file = await createTask(
      project.dir,
      {
        title: words.join(' '),
        status,
        owner: o.owner as string | undefined,
        author: (o.author as string) ?? defaultAuthor(),
        start: o.start as string | undefined,
        end: o.end as string | undefined,
        priority,
        tags: list(o.tags),
        dependsOn: list(o.depends),
      },
      project.taskExtension,
    );
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
    for (const t of tasks) console.log(`${t.status.padEnd(12)} ${taskLine(ws, t)}`);
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
    if (t.dependsOn.length) console.log(dim(`depends on: ${t.dependsOn.join(', ')}`));
    console.log(`\n${t.body.trim()}\n`);
  });

program
  .command('set <task> <assignments...>')
  .description('set front matter fields, e.g. mdpm set login status=done owner=eli tags=ui,auth (empty value deletes)')
  .action(async (ref: string, pairs: string[]) => {
    const ws = await load();
    const t = getTask(ws, ref);
    await updateTask(t.file, parseAssignments(pairs));
    console.log(`Updated ${rel(ws, t.file)}`);
  });

program
  .command('move <task> <status>')
  .description('change the status of a task')
  .action(async (ref: string, status: string) => {
    const ws = await load();
    const t = getTask(ws, ref);
    if (!t.home.statuses.includes(status)) {
      fail(
        `"${status}" is not a status of project "${t.home.name}". Use one of: ${t.home.statuses.join(', ')}; ` +
          `or add it to "statuses" in ${rel(ws, t.home.file)}, or use "mdpm set ${t.id} status=${status}" to force it.`,
      );
    }
    await updateTask(t.file, { status });
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
      console.log(`\n${bold(s.toUpperCase())} ${dim(`(${col.length})`)}`);
      for (const t of col) console.log(`  • ${taskLine(ws, t)}`);
    }
    console.log();
  });

program
  .command('check')
  .description('validate projects and tasks; exits 1 on errors')
  .option('--json', 'machine readable output')
  .action(async (o: { json?: boolean }) => {
    const ws = await load();
    if (o.json) console.log(JSON.stringify(ws.issues.map((i) => ({ ...i, file: rel(ws, i.file) })), null, 2));
    else {
      for (const i of ws.issues) console.log(`${i.level === 'error' ? red('error') : yellow('warn ')}  ${rel(ws, i.file)}: ${i.message}`);
      console.log(dim(`${ws.projects.length} projects, ${ws.tasks.length} tasks, ${ws.issues.length} issues`));
    }
    if (ws.issues.some((i) => i.level === 'error')) process.exitCode = 1;
  });

program
  .command('where')
  .description('print the folder that is scanned and the projects found')
  .action(async () => {
    const ws = await loadWorkspace(root());
    console.log(ws.root);
    for (const p of ws.projects) console.log(dim(`  ${p.id}  ${projectSubtree(p).length - 1} sub projects`));
  });

program.parseAsync().catch((e) => fail(e instanceof Error ? e.message : String(e)));
