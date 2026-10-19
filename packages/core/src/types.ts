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
  /** Front matter fields every task must have. Inherited. */
  required?: string[];
  /** Extra required fields per status, e.g. `in-progress: [owner]`. Inherited. */
  requiredByStatus?: Record<string, string[]>;
  [key: string]: unknown;
}

/** Keys with a meaning in `.proj`; anything else is passed through (and typo-checked). */
export const PROJECT_FIELDS = ['name', 'description', 'owner', 'statuses', 'taskExtension', 'ignore', 'required', 'requiredByStatus'];

/** Keys with a meaning in task front matter (plus accepted aliases for depends_on). */
export const TASK_FIELDS = ['id', 'title', 'status', 'owner', 'author', 'created', 'start', 'end', 'priority', 'tags', 'depends_on'];
export const TASK_FIELD_ALIASES = ['dependsOn', 'depends'];

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
  /** Effective `required` rule, after inheritance. */
  required: string[];
  /** Effective `requiredByStatus` rule, after inheritance. */
  requiredByStatus: Record<string, string[]>;
  /** 1-based line of each top-level key in the `.proj` file. */
  lines: Record<string, number>;
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
  /** 1-based line of each top-level front matter key in the file. */
  lines: Record<string, number>;
}

export interface Issue {
  level: 'error' | 'warning';
  /** Stable rule id, e.g. `task/status-unknown`. Documented in the README. */
  code: string;
  file: string;
  /** 1-based line, when the issue is about a specific line. */
  line?: number;
  /** The front matter / .proj key the issue is about. */
  field?: string;
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
