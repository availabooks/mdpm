import * as path from 'path';
import { PLACEHOLDERS, agentNames, parseAgentDefinition } from './agent';
import { QUESTIONS_HEADING, openQuestions, readiness } from './body';
import { buildTask, toPosix } from './build';
import { AGENT_MODES, BLOCKED_STATUS, Issue, PROJECT_FIELDS, Project, TASK_FIELDS, TASK_FIELD_ALIASES, Task, TaskMeta, Workspace } from './types';

/*
 * Validation rules. Every issue has a stable `code` so scripts and agents can react to
 * specific problems; the README lists them all. Messages always say how to fix the problem.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXAMPLE_DATE = '2026-10-19';

export function validateWorkspace(ws: Workspace): Issue[] {
  return [...ws.projects.flatMap((p) => validateProject(ws, p)), ...validateTasks(ws, ws.tasks)];
}

/** Checks the settings in a `.proj` file. */
export function validateProject(ws: Workspace, p: Project): Issue[] {
  const issues: Issue[] = [];
  const meta = p.meta;
  const add = (level: Issue['level'], code: string, field: string | undefined, message: string) =>
    issues.push({ level, code, file: p.file, field, line: field ? p.lines[field] : undefined, message });
  const has = (k: string) => meta[k] !== undefined && meta[k] !== null;

  for (const k of ['name', 'description', 'owner']) {
    if (has(k) && typeof meta[k] !== 'string') add('error', 'proj/field-type', k, `"${k}" must be text, e.g. ${k}: Website`);
  }

  if (has('statuses')) {
    const s = meta.statuses;
    if (!isStringList(s)) {
      add('error', 'proj/field-type', 'statuses', '"statuses" must be a list of column names, e.g. statuses: [todo, in-progress, done]');
    } else if (s.length === 0) {
      add('error', 'proj/statuses-empty', 'statuses', '"statuses" is empty. List at least one column, or delete the line to inherit the parent project\'s statuses.');
    } else {
      const dupes = s.filter((x, i) => s.indexOf(x) !== i);
      if (dupes.length) add('error', 'proj/statuses-duplicate', 'statuses', `"statuses" lists ${quoteList([...new Set(dupes)])} more than once. Remove the duplicates.`);
    }
  }

  if (has('taskExtension') && meta.taskExtension !== '.md' && meta.taskExtension !== '.task') {
    add('error', 'proj/field-value', 'taskExtension', `"taskExtension" is "${String(meta.taskExtension)}" but must be ".md" or ".task".`);
  }

  if (has('ignore')) {
    if (!isStringList(meta.ignore)) {
      add('error', 'proj/field-type', 'ignore', '"ignore" must be a list of folder names, e.g. ignore: [assets, drafts]');
    } else {
      const bad = meta.ignore.filter((x) => /[\\/*?]/.test(x));
      if (bad.length) add('warning', 'proj/field-value', 'ignore', `"ignore" takes plain folder names, not paths or globs: ${quoteList(bad)}. Use just the folder name, e.g. "assets".`);
    }
  }

  if (has('required')) {
    if (!isStringList(meta.required)) add('error', 'proj/field-type', 'required', '"required" must be a list of front matter fields, e.g. required: [owner]');
    else checkFieldNames(meta.required, 'required', add);
  }

  if (has('requiredByStatus')) {
    const r = meta.requiredByStatus;
    if (!isPlainObject(r) || !Object.values(r).every(isStringList)) {
      add('error', 'proj/field-type', 'requiredByStatus', '"requiredByStatus" must map statuses to lists of fields, e.g.\n  requiredByStatus:\n    in-progress: [owner]');
    } else {
      for (const [status, fields] of Object.entries(r)) {
        if (!p.statuses.includes(status)) {
          add(
            'error',
            'proj/required-unknown-status',
            'requiredByStatus',
            `"requiredByStatus" has a rule for "${status}", which is not a status of this project (${p.statuses.join(', ')}). Rename it to one of those, or remove it.`,
          );
        }
        checkFieldNames(fields, `requiredByStatus.${status}`, add);
      }
    }
  }

  if (has('agent')) checkAgentSettings(meta.agent, add);
  if (has('agents')) {
    if (p.parent) add('warning', 'proj/agents-not-root', 'agents', `"agents" is only read from the root .proj, so it is ignored here. Move it to ${rel(ws, rootOf(p).file)}.`);
    else checkAgentDefinitions(meta.agents, add);
  }

  for (const k of Object.keys(meta)) {
    const hint = typoOf(k, PROJECT_FIELDS);
    if (hint) {
      // If the intended key is absent, its value is silently lost, which deserves an error.
      const lost = meta[hint] === undefined;
      add(lost ? 'error' : 'warning', 'proj/unknown-field', k, `Unknown setting "${k}". Did you mean "${hint}"? ${lost ? `As written it is ignored and "${hint}" falls back to its inherited or default value.` : 'Unknown settings are ignored.'}`);
    }
  }
  return issues;
}

type Add = (level: Issue['level'], code: string, field: string | undefined, message: string) => void;

const AGENT_KEYS = ['enabled', 'unassigned', 'modes', 'maxTurns', 'allowedTools', 'maxBudgetUsd'];

function checkAgentSettings(a: unknown, add: Add) {
  if (!isPlainObject(a)) {
    add('error', 'proj/field-type', 'agent', '"agent" must be a block of settings, e.g.\n  agent:\n    enabled: true\n    unassigned: false');
    return;
  }
  for (const k of ['enabled', 'unassigned']) {
    if (a[k] !== undefined && typeof a[k] !== 'boolean') add('error', 'proj/field-type', 'agent', `"agent.${k}" must be true or false.`);
  }
  if (a.modes !== undefined) {
    if (!isStringList(a.modes)) add('error', 'proj/field-type', 'agent', `"agent.modes" must be a list, e.g. modes: [${AGENT_MODES.join(', ')}]`);
    else {
      const bad = a.modes.filter((m) => !(AGENT_MODES as string[]).includes(m));
      if (bad.length) add('error', 'proj/field-value', 'agent', `"agent.modes" lists ${quoteList(bad)}. The modes are ${AGENT_MODES.join(', ')}.`);
    }
  }
  if (a.maxTurns !== undefined && !(Number.isInteger(a.maxTurns) && (a.maxTurns as number) > 0)) add('error', 'proj/field-value', 'agent', '"agent.maxTurns" must be a whole number above 0, e.g. maxTurns: 50');
  if (a.maxBudgetUsd !== undefined && !(typeof a.maxBudgetUsd === 'number' && a.maxBudgetUsd > 0)) add('error', 'proj/field-value', 'agent', '"agent.maxBudgetUsd" must be a number above 0, e.g. maxBudgetUsd: 5');
  if (a.allowedTools !== undefined && !isStringList(a.allowedTools)) {
    add('error', 'proj/field-type', 'agent', '"agent.allowedTools" must be a list of tool rules, e.g. allowedTools: ["Bash(mdpm *)", "Bash(npm test)"]');
  }
  for (const k of Object.keys(a)) {
    if (AGENT_KEYS.includes(k)) continue;
    const hint = typoOf(k, AGENT_KEYS) ?? AGENT_KEYS.find((n) => n.toLowerCase() === k.toLowerCase());
    add('warning', 'proj/unknown-field', 'agent', `Unknown setting "agent.${k}".${hint ? ` Did you mean "${hint}"?` : ` The agent settings are ${AGENT_KEYS.join(', ')}.`} It is ignored.`);
  }
}

function checkAgentDefinitions(a: unknown, add: Add) {
  if (!isPlainObject(a)) {
    add('error', 'proj/field-type', 'agents', '"agents" must map agent names to commands, e.g.\n  agents:\n    default: claude\n    my-agent:\n      command: [my-agent, --prompt, "{prompt}"]');
    return;
  }
  const names = new Set(Object.keys(a).filter((k) => k !== 'default'));
  for (const [name, v] of Object.entries(a)) {
    if (name === 'default') {
      if (typeof v !== 'string') add('error', 'proj/field-type', 'agents', '"agents.default" must be the name of an agent, e.g. default: claude');
      else if (!names.has(v) && !parseAgentDefinition(v, {})) {
        add('error', 'proj/agent-unknown', 'agents', `"agents.default" is "${v}", which is not defined. Use claude, codex or cursor, or define "${v}" under "agents".`);
      }
      continue;
    }
    const def = parseAgentDefinition(name, v);
    if (!def) {
      add('error', 'proj/field-type', 'agents', `Agent "${name}" needs a command: a list of the program and its arguments, e.g.\n  ${name}:\n    command: [${name}, "{prompt}"]`);
      continue;
    }
    const used = [...def.command, ...(def.resume ?? []), ...(def.interactive ?? []), ...(def.continueInteractive ?? [])].flatMap((arg) => [...arg.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    const unknown = [...new Set(used.filter((u) => !PLACEHOLDERS.includes(u)))];
    if (unknown.length) {
      add('warning', 'proj/field-value', 'agents', `Agent "${name}" uses unknown placeholder${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `{${u}}`).join(', ')}; they are passed through as written. Known placeholders: ${PLACEHOLDERS.map((x) => `{${x}}`).join(', ')}.`);
    }
    if (!def.stdin && !used.includes('prompt') && !used.includes('promptFile')) {
      add('warning', 'proj/field-value', 'agents', `Agent "${name}" never receives the prompt. Add "{prompt}" or "{promptFile}" to its command, or set "stdin: true".`);
    }
  }
}

/** Checks tasks individually and against each other (ids, dependencies). */
export function validateTasks(ws: Workspace, tasks: Task[]): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map<string, Task[]>();
  for (const t of tasks) byId.set(t.id, [...(byId.get(t.id) ?? []), t]);
  const agents = agentNames(ws);

  for (const t of tasks) {
    const add = (level: Issue['level'], code: string, field: string | undefined, message: string) =>
      issues.push({ level, code, file: t.file, field, line: field ? t.lines[field] : undefined, message });
    checkTask(ws, t, add);
    checkAgentTask(t, agents, add);

    const same = byId.get(t.id)!;
    if (same.length > 1) {
      const others = same.filter((o) => o !== t).map((o) => rel(ws, o.file));
      add(
        'error',
        'task/duplicate-id',
        t.meta.id !== undefined ? 'id' : undefined,
        `Duplicate task id "${t.id}" (also used by ${others.join(', ')}). Rename one of the files, or give one an explicit "id:" in its front matter, so depends_on can tell them apart.`,
      );
    }

    const depField = t.meta.depends_on !== undefined ? 'depends_on' : t.meta.dependsOn !== undefined ? 'dependsOn' : 'depends';
    for (const dep of t.dependsOn) {
      if (dep === t.id) {
        add('error', 'task/dependency-self', depField, `The task lists itself in ${depField}. Remove "${dep}" from that list.`);
      } else if (!byId.has(dep)) {
        const hint = suggest(dep, [...byId.keys()]);
        add(
          'error',
          'task/dependency-unknown',
          depField,
          `${depField} lists "${dep}", but no task has that id.${hint ? ` Did you mean "${hint}"?` : ''} Use a task's id (its "id:" field, or its file name without the extension), or remove the entry.`,
        );
      } else if (isDone(t)) {
        const open = byId.get(dep)!.filter((d) => !isDone(d));
        for (const d of open) {
          add(
            'warning',
            'task/dependency-open',
            'status',
            `This task is "${t.status}" but its dependency "${dep}" is still "${d.status}". Finish ${rel(ws, d.file)} first, or move this task back.`,
          );
        }
      }
    }
  }

  for (const cycle of findCycles(tasks, byId)) {
    const path = [...cycle, cycle[0]].map((t) => t.id).join(' → ');
    for (const t of cycle) {
      issues.push({
        level: 'error',
        code: 'task/dependency-cycle',
        file: t.file,
        field: 'depends_on',
        line: t.lines.depends_on,
        message: `depends_on forms a cycle (${path}), so none of these tasks can ever start. Remove one of these dependencies.`,
      });
    }
  }
  return issues;
}

/** Rules for the agent workflow: blocked tasks carry questions; tasks queued for an agent are ready. */
function checkAgentTask(t: Task, agents: Set<string>, add: Add) {
  if (t.status === BLOCKED_STATUS && !openQuestions(t.body).length) {
    add(
      'warning',
      'task/blocked-without-question',
      'status',
      `The task is blocked but has no open question. Add what it is waiting for under "## ${QUESTIONS_HEADING}" as "- [ ] …", or move it back to another status.`,
    );
  }
  if (t.status === 'todo' && t.owner && agents.has(t.owner)) {
    const r = readiness(t.body);
    if (!r.ready) {
      add(
        'warning',
        'task/not-ready',
        'owner',
        `This task is queued for ${t.owner} but isn't ready, so the agent will only refine it. Add ${r.missing} (the "agent" template has every section: mdpm new --template agent).`,
      );
    }
  }
}

function checkTask(ws: Workspace, t: Task, add: Add) {
  const m = t.meta;
  const has = (k: string) => m[k] !== undefined && m[k] !== null;

  for (const k of ['id', 'title', 'status', 'owner', 'author', 'priority', 'branch', 'pr']) {
    if (has(k) && !isScalar(m[k])) add('error', 'task/field-type', k, `"${k}" must be a single value, e.g. ${k}: ${example(k)}`);
  }
  for (const k of ['tags', 'depends_on', ...TASK_FIELD_ALIASES]) {
    if (has(k) && !isScalar(m[k]) && !(Array.isArray(m[k]) && (m[k] as unknown[]).every(isScalar))) {
      add('error', 'task/field-type', k, `"${k}" must be a list, e.g. ${k}: [${k === 'tags' ? 'ui, backend' : 'other-task-id'}]`);
    }
  }

  if (has('status') && isScalar(m.status) && !t.home.statuses.includes(t.status)) {
    const hint = suggest(t.status, t.home.statuses);
    add(
      'error',
      'task/status-unknown',
      'status',
      `Status "${t.status}" is not a column of project "${t.home.name}" (${t.home.statuses.join(', ')}).${hint ? ` Did you mean "${hint}"?` : ''} Change "status:" to one of those, or add "${t.status}" to "statuses" in ${rel(ws, t.home.file)}.`,
    );
  }

  for (const k of ['created', 'start', 'end'] as const) {
    if (!has(k)) continue;
    const v: unknown = m[k];
    if (typeof v !== 'string' || !isRealDate(v)) {
      const shown = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      add('error', 'task/date-invalid', k, `"${k}" is "${shown}", which is not a valid date. Write it as YYYY-MM-DD, e.g. ${k}: ${EXAMPLE_DATE}`);
    }
  }
  if (t.start && t.end && isRealDate(t.start) && isRealDate(t.end) && t.end < t.start) {
    add('error', 'task/date-order', 'end', `"end" (${t.end}) is before "start" (${t.start}). Swap them or correct one of the dates.`);
  }

  for (const f of t.home.required) {
    if (isEmpty(m[f])) {
      add('error', 'task/required-missing', f, `Every task in "${t.home.name}" must have "${f}" (rule "required" in ${rel(ws, ruleSource(t.home, 'required'))}). Add "${f}: …" to the front matter.`);
    }
  }
  for (const f of t.home.requiredByStatus[t.status] ?? []) {
    if (isEmpty(m[f]) && !t.home.required.includes(f)) {
      add(
        'error',
        'task/required-missing',
        f,
        `Tasks in "${t.status}" must have "${f}" (rule "requiredByStatus" in ${rel(ws, ruleSource(t.home, 'requiredByStatus'))}). Add "${f}: …" to the front matter, or move the task to another status.`,
      );
    }
  }

  for (const k of Object.keys(m)) {
    const hint = typoOf(k, [...TASK_FIELDS, ...TASK_FIELD_ALIASES]);
    if (hint) {
      // If the intended field is absent, its value is silently lost (e.g. status falls back to the first column).
      const lost = m[hint] === undefined;
      add(
        lost ? 'error' : 'warning',
        'task/unknown-field',
        k,
        `Unknown field "${k}". Did you mean "${hint}"? ${lost ? `As written it is ignored, so the task has no "${hint}"${hint === 'status' ? ` and shows as "${t.status}"` : ''}.` : "mdpm ignores fields it doesn't know."}`,
      );
    }
  }
}

/**
 * Issues that applying `changes` (and, optionally, a new `body`) to `task` would introduce. Problems the task already had are
 * not repeated, so an unrelated old mistake never blocks a status change.
 */
export function previewTaskChange(ws: Workspace, task: Task, changes: Record<string, unknown>, body = task.body): Issue[] {
  const meta: TaskMeta = { ...task.meta };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || v === null || v === '') delete meta[k];
    else meta[k] = v;
  }
  const candidate = buildTask(task.file, meta, body, task.locations, task.lines);
  const key = (i: Issue) => `${i.code}|${i.field}|${i.message}`;
  const before = new Set(validateTasks(ws, ws.tasks).filter((i) => i.file === task.file).map(key));
  const after = validateTasks(ws, ws.tasks.map((t) => (t === task ? candidate : t))).filter((i) => i.file === task.file);
  return after.filter((i) => !before.has(key(i)));
}

/** Issues a new task with this front matter would have, if created at `file` in `project`. */
export function previewNewTask(ws: Workspace, project: Project, file: string, meta: TaskMeta): Issue[] {
  const candidate = buildTask(file, meta, '', [{ path: file, project }]);
  return validateTasks(ws, [...ws.tasks, candidate]).filter((i) => i.file === file);
}

/** Closest candidate by case-insensitive containment, for "did you mean" hints. */
export function suggest(ref: string, candidates: string[]): string | undefined {
  const r = ref.toLowerCase();
  return (
    candidates.find((c) => c.toLowerCase() === r) ??
    candidates.find((c) => c.toLowerCase().includes(r) || r.includes(c.toLowerCase())) ??
    candidates.find((c) => distance(c.toLowerCase(), r) <= 2)
  );
}

/** Returns the known key `key` was probably meant to be, or undefined if it is known or not close to one. */
function typoOf(key: string, known: string[]): string | undefined {
  if (known.includes(key)) return undefined;
  const k = key.toLowerCase().replace(/[-\s]/g, '_');
  const limit = k.length <= 4 ? 1 : 2;
  return known.find((n) => n.toLowerCase() === k) ?? known.find((n) => distance(n.toLowerCase(), k) <= limit);
}

function checkFieldNames(fields: string[], where: string, add: Add) {
  for (const f of fields) {
    const hint = typoOf(f, TASK_FIELDS);
    if (hint) add('warning', 'proj/unknown-field', where.split('.')[0], `"${where}" lists "${f}". Did you mean "${hint}"? As written, tasks must have a "${f}" field.`);
  }
}

function findCycles(tasks: Task[], byId: Map<string, Task[]>): Task[][] {
  const state = new Map<Task, 'visiting' | 'done'>();
  const stack: Task[] = [];
  const cycles: Task[][] = [];
  const seen = new Set<Task>();
  const visit = (t: Task) => {
    state.set(t, 'visiting');
    stack.push(t);
    for (const dep of t.dependsOn) {
      for (const d of byId.get(dep) ?? []) {
        if (d === t) continue; // reported as dependency-self
        if (state.get(d) === 'visiting') {
          const cycle = stack.slice(stack.indexOf(d));
          if (!cycle.some((c) => seen.has(c))) {
            cycle.forEach((c) => seen.add(c));
            cycles.push(cycle);
          }
        } else if (!state.has(d)) visit(d);
      }
    }
    stack.pop();
    state.set(t, 'done');
  };
  tasks.forEach((t) => state.has(t) || visit(t));
  return cycles;
}

function rootOf(p: Project): Project {
  return p.parent ? rootOf(p.parent) : p;
}

/** The project whose .proj actually defines an inherited rule. */
function ruleSource(p: Project, key: 'required' | 'requiredByStatus'): string {
  let cur: Project | undefined = p;
  while (cur && cur.meta[key] === undefined) cur = cur.parent;
  return (cur ?? p).file;
}

function isDone(t: Task): boolean {
  return t.status === t.home.statuses[t.home.statuses.length - 1];
}

function isRealDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number';
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);
}

function example(k: string): string {
  return { id: 'login-page', title: 'Login page', status: 'todo', owner: 'eli', author: 'eli', priority: '1' }[k] ?? 'value';
}

function quoteList(xs: string[]): string {
  return xs.map((x) => `"${x}"`).join(', ');
}

function rel(ws: Workspace, file: string): string {
  return toPosix(path.relative(ws.root, file)) || file;
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
