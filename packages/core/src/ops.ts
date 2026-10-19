import { execFileSync } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stringify } from 'yaml';
import { serializeFrontMatter, splitFrontMatter, updateFrontMatter } from './frontmatter';
import { isTaskFile, toPosix } from './workspace';
import { LinkKind, PROJECT_FILE, ProjectMeta, TaskExtension } from './types';

export interface NewTask {
  title: string;
  status?: string;
  owner?: string;
  author?: string;
  start?: string;
  end?: string;
  priority?: string | number;
  tags?: string[];
  dependsOn?: string[];
  /** Markdown body; defaults to a small template. */
  body?: string;
  /** Any additional front matter keys. */
  extra?: Record<string, unknown>;
}

/** Rewrites front matter keys of a task file in place. `null`/`undefined`/`''` delete a key. */
export async function updateTask(file: string, changes: Record<string, unknown>): Promise<void> {
  const text = await fs.readFile(file, 'utf8');
  let updated: string;
  try {
    updated = updateFrontMatter(text, changes);
  } catch (e) {
    throw new Error(`Cannot update ${file}: ${(e as Error).message}`);
  }
  await fs.writeFile(file, updated, 'utf8');
}

/** Creates a new task file in `dir` and returns its path. Never overwrites an existing file. */
export async function createTask(dir: string, task: NewTask, extension: TaskExtension = '.md'): Promise<string> {
  const data: Record<string, unknown> = {
    title: task.title,
    status: task.status,
    owner: task.owner,
    author: task.author,
    created: today(),
    start: task.start,
    end: task.end,
    priority: task.priority,
    tags: task.tags,
    depends_on: task.dependsOn,
    ...task.extra,
  };
  const body = task.body ?? `\n# ${task.title}\n\n## Description\n\n\n## Acceptance criteria\n\n- [ ] \n`;
  const content = serializeFrontMatter(data, body);

  await fs.mkdir(dir, { recursive: true });
  const base = slugify(task.title) || 'task';
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${base}${n > 1 ? `-${n}` : ''}${extension}`);
    try {
      await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** Creates a project folder with a `.proj` file. Fails if one already exists. */
export async function createProject(dir: string, meta: ProjectMeta): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, PROJECT_FILE);
  await fs.writeFile(file, stringify(meta, { lineWidth: 0 }), { encoding: 'utf8', flag: 'wx' });
  return file;
}

/**
 * Makes a task appear in another project folder without copying it. Creates a relative
 * symlink; where that isn't permitted (Windows without Developer Mode) it writes a stub
 * file containing the relative path, which the scanner treats the same way.
 */
export async function linkTask(taskFile: string, projectDir: string): Promise<{ path: string; kind: LinkKind }> {
  const dest = path.join(projectDir, path.basename(taskFile));
  if (existsSync(dest)) throw new Error(`${dest} already exists. If it is a link to this task, the task is already in that project; otherwise rename or remove that file and try again.`);
  const rel = path.relative(projectDir, taskFile);
  try {
    await fs.symlink(rel, dest, 'file');
    return { path: dest, kind: 'symlink' };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL'].includes(code ?? '')) throw e;
    await fs.writeFile(dest, toPosix(rel) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { path: dest, kind: 'stub' };
  }
}

/** Removes a link (symlink or stub) created by `linkTask`. Refuses to delete a real task. */
export async function unlinkTask(linkPath: string): Promise<void> {
  const st = await fs.lstat(linkPath);
  if (!st.isSymbolicLink()) {
    const text = await fs.readFile(linkPath, 'utf8');
    if (splitFrontMatter(text) || !isTaskFile(text.trim())) throw new Error(`${linkPath} is the task file itself, not a link to it, so it was not removed. To take the task out of its home project, move or delete the file instead.`);
  }
  await fs.unlink(linkPath);
}

/** Best guess at the current user's name: git config, then the OS user. */
export function defaultAuthor(cwd?: string): string {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (name) return name;
  } catch {
    // git missing or not configured
  }
  return os.userInfo().username;
}

/** Locates the folder to scan: `$MDPM_ROOT`, else the enclosing git repo, else the topmost `.proj` ancestor, else `start`. */
export function findRoot(start: string): string {
  if (process.env.MDPM_ROOT) return path.resolve(process.env.MDPM_ROOT);
  let dir = path.resolve(start);
  let topProject: string | undefined;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    if (existsSync(path.join(dir, PROJECT_FILE))) topProject = dir;
    const parent = path.dirname(dir);
    if (parent === dir) return topProject ?? path.resolve(start);
    dir = parent;
  }
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
