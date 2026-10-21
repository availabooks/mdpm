import { promises as fs, Dirent } from 'fs';
import * as path from 'path';
import { buildTask, str, stringList, toPosix } from './build';
import { parseFrontMatter, parseYamlMapping } from './frontmatter';
import {
  AgentSettings,
  DEFAULT_AGENT_SETTINGS,
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
import { validateWorkspace } from './validate';

/** Folders skipped everywhere (hidden folders are always skipped too). */
const ALWAYS_IGNORE = new Set(['node_modules']);
/** Folders skipped outside of projects, to keep scans of host repos fast. */
const IGNORE_OUTSIDE_PROJECTS = new Set(['dist', 'out', 'build', 'target', 'vendor', 'bin', 'obj', '__pycache__', 'venv']);

interface RawLocation extends TaskLocation {
  /** Real path of the task file this location resolves to. */
  target: string;
}

export function isTaskFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return (TASK_EXTENSIONS as readonly string[]).includes(ext);
}

/** Scans `root` for `.proj` files and the ideas inside them. Never throws on bad content. */
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
        ws.issues.push({ level: 'error', code: 'fs/read-error', file, message: `Cannot read idea file (${(e as Error).message}). Check that it exists and that you have permission to read it.` });
        continue;
      }
    }
    const parsed = parseFrontMatter(text);
    if (!parsed) {
      // A plain markdown file (README, notes...) is only a problem if something links to it.
      for (const l of locs.filter((l) => l.link)) {
        ws.issues.push({ level: 'warning', code: 'link/not-task', file: l.path, message: `This link points to ${file}, which is not an idea because it has no front matter. Add a --- front matter block to that file, or delete this link.` });
      }
      continue;
    }
    if (parsed.error) {
      ws.issues.push({
        level: 'error',
        code: 'task/yaml-invalid',
        file,
        line: parsed.errorLine,
        message: `Invalid front matter: ${parsed.error}. Fix the block between the --- lines at the top of the file; until then its fields are ignored.`,
      });
    }

    locs.sort((a, b) => Number(!!a.link) - Number(!!b.link) || a.path.localeCompare(b.path));
    const locations: TaskLocation[] = locs.map(({ path, project, link }) => (link ? { path, project, link } : { path, project }));
    ws.tasks.push(buildTask(file, parsed.data as TaskMeta, parsed.body, locations, parsed.lines));
  }

  ws.tasks.sort((a, b) => a.home.id.localeCompare(b.home.id) || a.title.localeCompare(b.title));
  ws.issues.push(...validateWorkspace(ws));
  return ws;
}

async function walk(dir: string, project: Project | undefined, ws: Workspace, raw: RawLocation[], texts: Map<string, string>) {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    ws.issues.push({ level: 'error', code: 'fs/read-error', file: dir, message: `Cannot read folder (${(e as Error).message}), so its ideas were skipped. Check the folder's permissions, or add its name to "ignore" in the nearest .proj.` });
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  if (entries.some((e) => e.name === PROJECT_FILE && !e.isDirectory())) {
    project = await loadProject(dir, project, ws);
  }
  const ignore = new Set(stringList(project?.meta.ignore));

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
          code: 'link/broken',
          file: full,
          message: `Broken link: points to "${target}", which doesn't exist. If the idea was moved or renamed, delete this link and link the idea again; otherwise just delete it.`,
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
  let lines: Record<string, number> = {};
  try {
    const parsed = parseYamlMapping(await fs.readFile(file, 'utf8'), 1);
    lines = parsed.lines;
    if (parsed.error) {
      ws.issues.push({
        level: 'error',
        code: 'proj/yaml-invalid',
        file,
        line: parsed.errorLine,
        message: `Invalid .proj: ${parsed.error}. Fix the file; until then this project uses inherited or default settings.`,
      });
    } else {
      meta = parsed.data as ProjectMeta;
    }
  } catch (e) {
    ws.issues.push({
      level: 'error',
      code: 'fs/read-error',
      file,
      message: `Cannot read .proj (${(e as Error).message}). Check that you have permission to read it; until then this project uses inherited or default settings.`,
    });
  }

  // Invalid values fall back to the inherited ones; validateProject reports them.
  const ext = meta.taskExtension === '.task' || meta.taskExtension === '.md' ? meta.taskExtension : undefined;
  const project: Project = {
    id: toPosix(path.relative(ws.root, dir)) || '.',
    name: str(meta.name) ?? path.basename(dir),
    dir,
    file,
    meta,
    parent,
    children: [],
    taskExtension: ext ?? parent?.taskExtension ?? ('.md' as TaskExtension),
    agent: agentSettings(meta.agent, parent?.agent ?? DEFAULT_AGENT_SETTINGS),
    lines,
  };
  parent?.children.push(project);
  ws.projects.push(project);
  return project;
}

/** Merges a `.proj` `agent:` block over the inherited settings, key by key. Invalid values are ignored (and reported by validateProject). */
function agentSettings(raw: unknown, inherited: AgentSettings): AgentSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return inherited;
  const r = raw as Record<string, unknown>;
  const out: AgentSettings = { ...inherited };
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (Number.isInteger(r.maxTurns) && (r.maxTurns as number) > 0) out.maxTurns = r.maxTurns as number;
  if (Array.isArray(r.allowedTools) && r.allowedTools.every((t) => typeof t === 'string')) out.allowedTools = r.allowedTools as string[];
  if (typeof r.maxBudgetUsd === 'number' && r.maxBudgetUsd > 0) out.maxBudgetUsd = r.maxBudgetUsd;
  return out;
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

export { toPosix };
export type { LinkKind, Task };
