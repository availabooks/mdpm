import { promises as fs, Dirent } from 'fs';
import * as path from 'path';
import { parseDocument } from 'yaml';
import { parseFrontMatter } from './frontmatter';
import {
  DEFAULT_STATUSES,
  Issue,
  LinkKind,
  PROJECT_FILE,
  Project,
  ProjectMeta,
  TASK_EXTENSIONS,
  Task,
  TaskExtension,
  TaskLocation,
  TaskMeta,
  Workspace,
} from './types';

/** Folders skipped everywhere (hidden folders are always skipped too). */
const ALWAYS_IGNORE = new Set(['node_modules']);
/** Folders skipped outside of projects, to keep scans of host repos fast. */
const IGNORE_OUTSIDE_PROJECTS = new Set(['dist', 'out', 'build', 'target', 'vendor', 'bin', 'obj', '__pycache__', 'venv']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface RawLocation extends TaskLocation {
  /** Real path of the task file this location resolves to. */
  target: string;
}

export function isTaskFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return (TASK_EXTENSIONS as readonly string[]).includes(ext);
}

/** Scans `root` for `.proj` files and the tasks inside them. Never throws on bad content. */
export async function loadWorkspace(root: string): Promise<Workspace> {
  root = path.resolve(root);
  const ws: Workspace = { root, projects: [], tasks: [], issues: [] };
  const raw: RawLocation[] = [];
  const texts = new Map<string, string>();
  await walk(root, undefined, ws, raw, texts);

  const groups = new Map<string, RawLocation[]>();
  for (const loc of raw) {
    const list = groups.get(loc.target) ?? [];
    list.push(loc);
    groups.set(loc.target, list);
  }

  for (const [file, locs] of groups) {
    let text = texts.get(file);
    if (text === undefined) {
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (e) {
        ws.issues.push({ level: 'error', file, message: `Cannot read task file (${(e as Error).message}). Check that it exists and that you have permission to read it.` });
        continue;
      }
    }
    const parsed = parseFrontMatter(text);
    if (!parsed) {
      // A plain markdown file (README, notes...) is only a problem if something links to it.
      for (const l of locs.filter((l) => l.link)) {
        ws.issues.push({ level: 'warning', file: l.path, message: `This link points to ${file}, which is not a task because it has no front matter. Add a --- front matter block to that file, or delete this link.` });
      }
      continue;
    }
    if (parsed.error) ws.issues.push({ level: 'error', file, message: `Invalid YAML in front matter: ${parsed.error}. Fix the block between the --- lines at the top of the file; until then its fields are ignored.` });

    locs.sort((a, b) => Number(!!a.link) - Number(!!b.link) || a.path.localeCompare(b.path));
    const locations: TaskLocation[] = locs.map(({ path, project, link }) => (link ? { path, project, link } : { path, project }));
    ws.tasks.push(buildTask(file, parsed.data as TaskMeta, parsed.body, locations));
  }

  ws.tasks.sort((a, b) => a.home.id.localeCompare(b.home.id) || a.title.localeCompare(b.title));
  validate(ws);
  return ws;
}

async function walk(dir: string, project: Project | undefined, ws: Workspace, raw: RawLocation[], texts: Map<string, string>) {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    ws.issues.push({ level: 'error', file: dir, message: `Cannot read folder (${(e as Error).message}), so its tasks were skipped. Check the folder's permissions, or add its name to "ignore" in the nearest .proj.` });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (entries.some((e) => e.name === PROJECT_FILE && !e.isDirectory())) {
    project = await loadProject(dir, project, ws);
  }
  const ignore = new Set(project?.meta.ignore ?? []);

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);

    if (e.isDirectory()) {
      if (ALWAYS_IGNORE.has(e.name) || ignore.has(e.name)) continue;
      if (!project && IGNORE_OUTSIDE_PROJECTS.has(e.name)) continue;
      await walk(full, project, ws, raw, texts);
      continue;
    }
    if (!project || !isTaskFile(e.name)) continue;

    if (e.isSymbolicLink()) {
      // Symlinked folders are never followed, so link cycles are impossible.
      try {
        const target = await fs.realpath(full);
        if (!(await fs.stat(target)).isFile()) continue;
        raw.push({ path: full, project, link: 'symlink', target });
      } catch {
        const target = await fs.readlink(full).catch(() => '?');
        ws.issues.push({
          level: 'error',
          file: full,
          message: `Broken link: points to "${target}", which doesn't exist. If the task was moved or renamed, delete this link and link the task again; otherwise just delete it.`,
        });
      }
      continue;
    }

    if (e.isFile()) {
      const target = await fs.realpath(full);
      const text = await fs.readFile(target, 'utf8');
      const stubTarget = await resolveStub(full, text);
      if (stubTarget) {
        raw.push({ path: full, project, link: 'stub', target: stubTarget });
      } else {
        texts.set(target, text);
        raw.push({ path: full, project, target });
      }
    }
  }
}

/**
 * A "stub" is a one-line file holding a relative path to another task file. Git produces
 * these on Windows when `core.symlinks` is off, so we treat them exactly like symlinks.
 */
async function resolveStub(file: string, text: string): Promise<string | undefined> {
  const t = text.trim();
  if (!t || t.length > 1024 || /[\r\n]/.test(t) || t.startsWith('---') || !isTaskFile(t)) return undefined;
  const resolved = path.resolve(path.dirname(file), t);
  try {
    if ((await fs.stat(resolved)).isFile()) return await fs.realpath(resolved);
  } catch {
    // Not a path after all; treat as an ordinary (front-matter-less) file.
  }
  return undefined;
}

async function loadProject(dir: string, parent: Project | undefined, ws: Workspace): Promise<Project> {
  const file = path.join(dir, PROJECT_FILE);
  let meta: ProjectMeta = {};
  try {
    const doc = parseDocument(await fs.readFile(file, 'utf8'));
    if (doc.errors.length) {
      ws.issues.push({ level: 'error', file, message: `Invalid YAML in .proj: ${doc.errors[0].message}. Fix the file; until then this project uses inherited or default settings.` });
    } else {
      const js = doc.toJS();
      if (js && typeof js === 'object' && !Array.isArray(js)) meta = js as ProjectMeta;
      else if (js != null) ws.issues.push({ level: 'error', file, message: '.proj must contain "key: value" lines, e.g. "name: My project". Replace its contents; until then this project uses inherited or default settings.' });
    }
  } catch (e) {
    ws.issues.push({ level: 'error', file, message: `Cannot read .proj (${(e as Error).message}). Check that you have permission to read it; until then this project uses inherited or default settings.` });
  }

  const statuses = stringList(meta.statuses);
  const ext = meta.taskExtension === '.task' || meta.taskExtension === '.md' ? meta.taskExtension : undefined;
  const project: Project = {
    id: toPosix(path.relative(ws.root, dir)) || '.',
    name: str(meta.name) ?? path.basename(dir),
    dir,
    file,
    meta,
    parent,
    children: [],
    statuses: statuses.length ? statuses : parent?.statuses ?? DEFAULT_STATUSES,
    taskExtension: ext ?? parent?.taskExtension ?? ('.md' as TaskExtension),
  };
  parent?.children.push(project);
  ws.projects.push(project);
  return project;
}

function buildTask(file: string, meta: TaskMeta, body: string, locations: TaskLocation[]): Task {
  const home = locations[0].project;
  const base = path.basename(file, path.extname(file));
  return {
    id: str(meta.id) ?? base,
    title: str(meta.title) ?? firstHeading(body) ?? base,
    status: str(meta.status) ?? home.statuses[0],
    owner: str(meta.owner),
    author: str(meta.author),
    created: date(meta.created),
    start: date(meta.start),
    end: date(meta.end),
    priority: typeof meta.priority === 'number' ? meta.priority : str(meta.priority),
    tags: stringList(meta.tags),
    dependsOn: stringList(meta.depends_on ?? meta.dependsOn ?? meta.depends),
    file,
    locations,
    home,
    meta,
    body,
  };
}

function validate(ws: Workspace) {
  const byId = new Map<string, Task[]>();
  for (const t of ws.tasks) byId.set(t.id, [...(byId.get(t.id) ?? []), t]);

  const warn = (file: string, message: string, level: Issue['level'] = 'warning') => ws.issues.push({ level, file, message });
  for (const [id, tasks] of byId) {
    if (tasks.length <= 1) continue;
    for (const t of tasks) {
      const others = tasks.filter((o) => o !== t).map((o) => toPosix(path.relative(ws.root, o.file)));
      warn(
        t.file,
        `Duplicate task id "${id}" (also used by ${others.join(', ')}). Rename one of the files, or give one an explicit "id:" in its front matter, so depends_on can tell them apart.`,
        'error',
      );
    }
  }
  for (const t of ws.tasks) {
    if (!t.home.statuses.includes(t.status)) {
      warn(
        t.file,
        `Status "${t.status}" is not a column of project "${t.home.name}" (${t.home.statuses.join(', ')}). Change "status:" to one of those, or add "${t.status}" to "statuses" in the project's .proj.`,
      );
    }
    for (const field of ['created', 'start', 'end'] as const) {
      const v = t[field];
      if (v && !DATE_RE.test(v)) warn(t.file, `"${field}" is "${v}" but must be a date written as YYYY-MM-DD, e.g. 2026-10-19.`);
    }
    if (t.start && t.end && DATE_RE.test(t.start) && DATE_RE.test(t.end) && t.end < t.start) {
      warn(t.file, `"end" (${t.end}) is before "start" (${t.start}). Swap them or correct one of the dates.`);
    }
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) {
        const hint = suggest(dep, [...byId.keys()]);
        warn(
          t.file,
          `depends_on lists "${dep}", but no task has that id.${hint ? ` Did you mean "${hint}"?` : ''} Use a task's id (its "id:" field, or its file name without the extension), or remove the entry.`,
        );
      }
      if (dep === t.id) warn(t.file, `The task lists itself in depends_on. Remove "${dep}" from that list.`);
    }
  }
}

/** Closest candidate by case-insensitive containment, for "did you mean" hints. */
export function suggest(ref: string, candidates: string[]): string | undefined {
  const r = ref.toLowerCase();
  return candidates.find((c) => c.toLowerCase() === r) ?? candidates.find((c) => c.toLowerCase().includes(r) || r.includes(c.toLowerCase()));
}

function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return m?.[1];
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function date(v: unknown): string | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return str(v);
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s): s is string => !!s);
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** All projects in the subtree rooted at `project`, including itself. */
export function projectSubtree(project: Project): Project[] {
  return [project, ...project.children.flatMap(projectSubtree)];
}

/** Tasks that appear in `project` (directly, or in a sub project when `deep`). */
export function tasksInProject(ws: Workspace, project: Project, deep = true): Task[] {
  const set = new Set(deep ? projectSubtree(project) : [project]);
  return ws.tasks.filter((t) => t.locations.some((l) => set.has(l.project)));
}

/** Finds a task by id, or by a path (absolute or relative to the workspace root). */
export function findTask(ws: Workspace, ref: string): Task | undefined {
  const byId = ws.tasks.find((t) => t.id === ref);
  if (byId) return byId;
  const abs = path.resolve(ws.root, ref);
  return ws.tasks.find((t) => t.file === abs || t.locations.some((l) => l.path === abs));
}

/** Finds a project by id (relative folder), folder path, unique name, or unique folder name. */
export function findProject(ws: Workspace, ref: string): Project | undefined {
  const norm = toPosix(ref).replace(/\/+$/, '') || '.';
  const abs = path.resolve(ws.root, ref);
  const exact = ws.projects.find((p) => p.id === norm || p.dir === abs);
  if (exact) return exact;
  const lower = ref.toLowerCase();
  for (const match of [(p: Project) => p.name.toLowerCase() === lower, (p: Project) => path.basename(p.dir).toLowerCase() === lower]) {
    const found = ws.projects.filter(match);
    if (found.length === 1) return found[0];
  }
  return undefined;
}

/** Returns the location of a task inside `project`, if any. */
export function locationIn(task: Task, project: Project): TaskLocation | undefined {
  return task.locations.find((l) => l.project === project);
}

export type { LinkKind };
