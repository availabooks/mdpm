/** Name of the file that marks a folder as a project. */
export const PROJECT_FILE = '.proj';

/** File extensions that may contain tasks. */
export const TASK_EXTENSIONS = ['.md', '.task'] as const;
export type TaskExtension = (typeof TASK_EXTENSIONS)[number];

/** Kanban columns used when no `.proj` file in the chain defines `statuses`. */
export const DEFAULT_STATUSES = ['backlog', 'todo', 'in-progress', 'review', 'done'];

/** Contents of a `.proj` file. Unknown keys are preserved and passed through. */
export interface ProjectMeta {
  name?: string;
  description?: string;
  owner?: string;
  /** Ordered Kanban columns. Inherited by sub projects that don't define their own. */
  statuses?: string[];
  /** Extension used for new tasks (default `.md`). Inherited. */
  taskExtension?: TaskExtension;
  /** Folder names (not globs) to skip while scanning this project. */
  ignore?: string[];
  [key: string]: unknown;
}

export interface Project {
  /** Path of the project folder relative to the workspace root, `/`-separated (`.` for the root). */
  id: string;
  name: string;
  /** Absolute path of the project folder. */
  dir: string;
  /** Absolute path of the `.proj` file. */
  file: string;
  meta: ProjectMeta;
  parent?: Project;
  children: Project[];
  /** Effective statuses, after inheritance. */
  statuses: string[];
  /** Effective extension for new tasks, after inheritance. */
  taskExtension: TaskExtension;
}

/**
 * How a task file appears in a project folder that isn't its home.
 * - `symlink`: a real filesystem symlink.
 * - `stub`: a plain text file containing a relative path. This is what git checks out
 *   on Windows when symlinks are disabled, and our fallback when we can't create one.
 */
export type LinkKind = 'symlink' | 'stub';

export interface TaskLocation {
  /** Absolute path where the task appears (may be a link). */
  path: string;
  project: Project;
  link?: LinkKind;
}

/** Front matter fields with special meaning. Any other keys are kept as-is. */
export interface TaskMeta {
  id?: string;
  title?: string;
  status?: string;
  owner?: string;
  author?: string;
  created?: string;
  start?: string;
  end?: string;
  priority?: string | number;
  tags?: string[];
  depends_on?: string[];
  [key: string]: unknown;
}

export interface Task {
  /** `id` from front matter, else the file name without extension. */
  id: string;
  title: string;
  status: string;
  owner?: string;
  author?: string;
  created?: string;
  start?: string;
  end?: string;
  priority?: string | number;
  tags: string[];
  dependsOn: string[];
  /** Canonical (real) path of the task file. Always write here. */
  file: string;
  /** Every place the task appears, the home location first. */
  locations: TaskLocation[];
  /** Project that owns the real file (or the first project linking to it). */
  home: Project;
  meta: TaskMeta;
  body: string;
}

export interface Issue {
  level: 'error' | 'warning';
  file: string;
  message: string;
}

export interface Workspace {
  root: string;
  /** All projects, depth first. */
  projects: Project[];
  /** Unique tasks; a task linked into several projects appears once. */
  tasks: Task[];
  issues: Issue[];
}
