/** Name of the file that marks a folder as a project. */
export const PROJECT_FILE = '.proj';

/** File extensions that may contain ideas. */
export const TASK_EXTENSIONS = ['.md', '.task'] as const;
export type TaskExtension = (typeof TASK_EXTENSIONS)[number];

/**
 * The AI flow: idea → plan → executing → review → done, plus blocked (waiting for an answer).
 * Fixed for every project. Design: docs/agent-workflow.md.
 */
export const STATUSES = ['idea', 'plan', 'executing', 'blocked', 'review', 'done'] as const;
export type Status = (typeof STATUSES)[number];

export const BLOCKED_STATUS = 'blocked';

/** Statuses an idea can be blocked from, and returns to when unblocked. */
export const BLOCKABLE_STATUSES = ['idea', 'plan', 'executing'] as const;
export type BlockableStatus = (typeof BLOCKABLE_STATUSES)[number];

/** What an agent run does: turn an idea into a plan, or build an approved plan. */
export type AgentMode = 'plan' | 'execute';
export const AGENT_MODES: AgentMode[] = ['plan', 'execute'];

/** Effective `agent:` settings of a project, after inheritance and defaults. */
export interface AgentSettings {
  /** Agents may plan and execute ideas in this project. */
  enabled: boolean;
  /** Turn limit per run. */
  maxTurns: number;
  /** Tools granted to the agent CLI, e.g. `Bash(npm test)`. */
  allowedTools: string[];
  /** Client-side spending cap per run, for agents that support one. */
  maxBudgetUsd?: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: true,
  maxTurns: 50,
  allowedTools: ['Bash(mdpm *)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git add *)', 'Bash(git commit *)'],
};

/** Contents of a `.proj` file. Unknown keys are preserved and passed through. */
export interface ProjectMeta {
  name?: string;
  description?: string;
  owner?: string;
  /** Extension used for new ideas (default `.md`). Inherited. */
  taskExtension?: TaskExtension;
  /** Folder names (not globs) to skip while scanning this project. */
  ignore?: string[];
  /** Settings for agents working in this project. Inherited key by key. */
  agent?: Partial<AgentSettings>;
  /** Agent CLI definitions (root `.proj` only). */
  agents?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Keys with a meaning in `.proj`; anything else is passed through (and typo-checked). */
export const PROJECT_FIELDS = ['name', 'description', 'owner', 'taskExtension', 'ignore', 'agent', 'agents'];
/** `.proj` keys from the task-based workflow; `mdpm migrate` removes them. */
export const OBSOLETE_PROJECT_FIELDS = ['statuses', 'required', 'requiredByStatus'];

/** Keys with a meaning in an idea's front matter. */
export const TASK_FIELDS = ['id', 'title', 'status', 'author', 'created', 'priority', 'tags', 'approved', 'blocked_from', 'branch', 'pr', 'completed'];
/** Front matter fields from the task-based workflow; `mdpm migrate` removes them. */
export const OBSOLETE_TASK_FIELDS = ['owner', 'start', 'end', 'depends_on', 'dependsOn', 'depends'];

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
  /** Effective extension for new ideas, after inheritance. */
  taskExtension: TaskExtension;
  /** Effective `agent:` settings, after inheritance. */
  agent: AgentSettings;
  /** 1-based line of each top-level key in the `.proj` file. */
  lines: Record<string, number>;
}

/**
 * How an idea file appears in a project folder that isn't its home.
 * - `symlink`: a real filesystem symlink.
 * - `stub`: a plain text file containing a relative path. This is what git checks out
 *   on Windows when symlinks are disabled, and our fallback when we can't create one.
 */
export type LinkKind = 'symlink' | 'stub';

export interface TaskLocation {
  /** Absolute path where the idea appears (may be a link). */
  path: string;
  project: Project;
  link?: LinkKind;
}

/** Front matter fields with special meaning. Any other keys are kept as-is. */
export interface TaskMeta {
  id?: string;
  title?: string;
  status?: string;
  author?: string;
  created?: string;
  priority?: string | number;
  tags?: string[];
  /** Date the person approved the plan (`mdpm approve`); absent while the plan waits for them. */
  approved?: string;
  /** While blocked: the status the idea returns to when unblocked. */
  blocked_from?: string;
  /** Branch holding the work (`idea/<id>`), set when execution starts. */
  branch?: string;
  /** Pull request URL, recorded by `mdpm handoff` or the runner. */
  pr?: string;
  /** Date the idea was accepted (moved to done). */
  completed?: string;
  [key: string]: unknown;
}

/**
 * An idea: one markdown file moving through the flow. (Called a task in the code, where the
 * name is shared with the file-level machinery: scanning, links, validation.)
 */
export interface Task {
  /** `id` from front matter, else the file name without extension. */
  id: string;
  title: string;
  status: string;
  author?: string;
  created?: string;
  priority?: string | number;
  tags: string[];
  approved?: string;
  blockedFrom?: string;
  branch?: string;
  pr?: string;
  completed?: string;
  /** Canonical (real) path of the file. Always write here. */
  file: string;
  /** Every place the idea appears, the home location first. */
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
  /** Unique ideas; an idea linked into several projects appears once. */
  tasks: Task[];
  issues: Issue[];
}
