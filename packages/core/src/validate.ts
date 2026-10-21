import * as path from 'path';
import { PLACEHOLDERS, parseAgentDefinition } from './agent';
import { OBSOLETE_HEADINGS, QUESTIONS_HEADING, headings, openQuestions, planCheck } from './body';
import { buildTask, toPosix } from './build';
import { inSlot, isBlockable, isStatus } from './flow';
import {
  BLOCKABLE_STATUSES,
  BLOCKED_STATUS,
  Issue,
  OBSOLETE_PROJECT_FIELDS,
  OBSOLETE_TASK_FIELDS,
  PROJECT_FIELDS,
  Project,
  STATUSES,
  TASK_FIELDS,
  Task,
  TaskMeta,
  Workspace,
} from './types';

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

  for (const k of OBSOLETE_PROJECT_FIELDS) {
    if (has(k)) {
      add('warning', 'proj/obsolete-field', k, `"${k}" is from the task-based workflow and is ignored: every project uses the flow's statuses (${STATUSES.join(', ')}). Delete it, or run "mdpm migrate --write" to update the whole workspace.`);
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

  if (has('agent')) checkAgentSettings(meta.agent, add);
  if (has('agents')) {
    if (p.parent) add('warning', 'proj/agents-not-root', 'agents', `"agents" is only read from the root .proj, so it is ignored here. Move it to ${rel(ws, rootOf(p).file)}.`);
    else checkAgentDefinitions(meta.agents, add);
  }

  for (const k of Object.keys(meta)) {
    if (OBSOLETE_PROJECT_FIELDS.includes(k)) continue;
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

const AGENT_KEYS = ['enabled', 'maxTurns', 'allowedTools', 'maxBudgetUsd'];
const OBSOLETE_AGENT_KEYS = ['unassigned', 'modes'];

function checkAgentSettings(a: unknown, add: Add) {
  if (!isPlainObject(a)) {
    add('error', 'proj/field-type', 'agent', '"agent" must be a block of settings, e.g.\n  agent:\n    enabled: true\n    maxTurns: 50');
    return;
  }
  if (a.enabled !== undefined && typeof a.enabled !== 'boolean') add('error', 'proj/field-type', 'agent', '"agent.enabled" must be true or false.');
  if (a.maxTurns !== undefined && !(Number.isInteger(a.maxTurns) && (a.maxTurns as number) > 0)) add('error', 'proj/field-value', 'agent', '"agent.maxTurns" must be a whole number above 0, e.g. maxTurns: 50');
  if (a.maxBudgetUsd !== undefined && !(typeof a.maxBudgetUsd === 'number' && a.maxBudgetUsd > 0)) add('error', 'proj/field-value', 'agent', '"agent.maxBudgetUsd" must be a number above 0, e.g. maxBudgetUsd: 5');
  if (a.allowedTools !== undefined && !isStringList(a.allowedTools)) {
    add('error', 'proj/field-type', 'agent', '"agent.allowedTools" must be a list of tool rules, e.g. allowedTools: ["Bash(mdpm *)", "Bash(npm test)"]');
  }
  for (const k of Object.keys(a)) {
    if (AGENT_KEYS.includes(k)) continue;
    if (OBSOLETE_AGENT_KEYS.includes(k)) {
      add('warning', 'proj/obsolete-field', 'agent', `"agent.${k}" is from the task-based workflow and is ignored: the agent plans every idea and executes every approved plan, one at a time. Delete it, or run "mdpm migrate --write".`);
      continue;
    }
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

/** Checks ideas individually and against each other (ids, the execution slot). */
export function validateTasks(ws: Workspace, tasks: Task[]): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map<string, Task[]>();
  for (const t of tasks) byId.set(t.id, [...(byId.get(t.id) ?? []), t]);
  const slot = tasks.filter(inSlot);

  for (const t of tasks) {
    const add = (level: Issue['level'], code: string, field: string | undefined, message: string) =>
      issues.push({ level, code, file: t.file, field, line: field ? t.lines[field] : undefined, message });
    checkTask(t, add);
    checkFlow(t, add);

    const same = byId.get(t.id)!;
    if (same.length > 1) {
      const others = same.filter((o) => o !== t).map((o) => rel(ws, o.file));
      add(
        'error',
        'task/duplicate-id',
        t.meta.id !== undefined ? 'id' : undefined,
        `Duplicate idea id "${t.id}" (also used by ${others.join(', ')}). Rename one of the files, or give one an explicit "id:" in its front matter, so commands can tell them apart.`,
      );
    }

    if (slot.length > 1 && slot.includes(t)) {
      const others = slot.filter((o) => o !== t).map((o) => `"${o.id}"`);
      add(
        'error',
        'task/slot-taken',
        'status',
        `Only one idea can hold the execution slot (executing, or blocked while executing), but ${others.join(', ')} ${others.length > 1 ? 'hold' : 'holds'} it too. Move all but one back to the plan queue with "mdpm move <id> plan".`,
      );
    }
  }
  return issues;
}

/** Rules of the flow: blocked ideas say what they wait for and where they return; approvals fit the status. */
function checkFlow(t: Task, add: Add) {
  if (t.status === BLOCKED_STATUS) {
    if (!openQuestions(t.body).length) {
      add('warning', 'task/blocked-without-question', 'status', `The idea is blocked but has no open question. Add what it is waiting for under "## ${QUESTIONS_HEADING}" as "- [ ] …", or unblock it (mdpm unblock ${t.id}).`);
    }
    if (!t.blockedFrom) {
      add('error', 'task/blocked-from-missing', 'status', `The idea is blocked but has no "blocked_from", so it is unclear where it returns when unblocked. Add "blocked_from: ${BLOCKABLE_STATUSES.join(' | ')}" to the front matter.`);
    } else if (!isBlockable(t.blockedFrom)) {
      add('error', 'task/blocked-from-invalid', 'blocked_from', `"blocked_from" is "${t.blockedFrom}", but an idea can only be blocked from ${BLOCKABLE_STATUSES.join(', ')}. Change it to the status the idea should return to.`);
    }
  } else if (t.meta.blocked_from !== undefined) {
    add('warning', 'task/blocked-from-stale', 'blocked_from', `"blocked_from" only applies to blocked ideas, and this one is "${t.status}". Delete the line.`);
  }
  if (t.approved && t.status === 'idea') {
    add('warning', 'task/approved-idea', 'approved', `The idea is marked approved but has no plan yet, so it will be planned like any other idea. Delete "approved", or approve it once its plan is written (mdpm approve ${t.id}).`);
  }
  if (t.status === 'plan' && t.approved && !planCheck(t.body).complete) {
    add('warning', 'task/plan-incomplete', 'approved', `The plan is approved but has no acceptance criteria, so the agent can't tell when it is done. Add ${planCheck(t.body).missing}.`);
  }
  for (const h of headings(t.body)) {
    const now = OBSOLETE_HEADINGS[h];
    if (now) add('warning', 'task/obsolete-section', undefined, `The section "## ${h[0].toUpperCase()}${h.slice(1)}" is from the task-based workflow; the flow uses "## ${now}". Rename it, or run "mdpm migrate --write".`);
  }
}

function checkTask(t: Task, add: Add) {
  const m = t.meta;
  const has = (k: string) => m[k] !== undefined && m[k] !== null;

  for (const k of ['id', 'title', 'status', 'author', 'priority', 'branch', 'pr', 'blocked_from']) {
    if (has(k) && !isScalar(m[k])) add('error', 'task/field-type', k, `"${k}" must be a single value, e.g. ${k}: ${example(k)}`);
  }
  if (has('tags') && !isScalar(m.tags) && !(Array.isArray(m.tags) && m.tags.every(isScalar))) {
    add('error', 'task/field-type', 'tags', '"tags" must be a list, e.g. tags: [ui, backend]');
  }

  if (has('status') && isScalar(m.status) && !isStatus(t.status)) {
    const old = OLD_STATUSES[t.status];
    const hint = old ? undefined : suggest(t.status, [...STATUSES]);
    add(
      'error',
      'task/status-unknown',
      'status',
      old
        ? `Status "${t.status}" is from the task-based workflow; in the flow it is "${old}". Run "mdpm migrate --write" to update the whole workspace, or change it here.`
        : `Status "${t.status}" is not part of the flow (${STATUSES.join(', ')}).${hint ? ` Did you mean "${hint}"?` : ''} Change "status:" to one of those.`,
    );
  }

  for (const k of ['created', 'approved', 'completed'] as const) {
    if (!has(k)) continue;
    const v: unknown = m[k];
    if (typeof v !== 'string' || !isRealDate(v)) {
      const shown = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      add('error', 'task/date-invalid', k, `"${k}" is "${shown}", which is not a valid date. Write it as YYYY-MM-DD, e.g. ${k}: ${EXAMPLE_DATE}`);
    }
  }

  for (const k of Object.keys(m)) {
    if (OBSOLETE_TASK_FIELDS.includes(k)) {
      add('warning', 'task/obsolete-field', k, `"${k}" is from the task-based workflow and is ignored by the flow. Delete it, or run "mdpm migrate --write" to update the whole workspace.`);
      continue;
    }
    const hint = typoOf(k, TASK_FIELDS);
    if (hint) {
      // If the intended field is absent, its value is silently lost (e.g. status falls back to idea).
      const lost = m[hint] === undefined;
      add(
        lost ? 'error' : 'warning',
        'task/unknown-field',
        k,
        `Unknown field "${k}". Did you mean "${hint}"? ${lost ? `As written it is ignored, so the idea has no "${hint}"${hint === 'status' ? ` and shows as "${t.status}"` : ''}.` : "mdpm ignores fields it doesn't know."}`,
      );
    }
  }
}

/** Statuses of the task-based workflow, and the flow status `mdpm migrate` usually gives them. */
const OLD_STATUSES: Record<string, string> = { backlog: 'idea', todo: 'plan', 'in-progress': 'executing', doing: 'executing', planned: 'plan', building: 'executing' };

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

/** Issues a new idea with this front matter would have, if created at `file` in `project`. */
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

function rootOf(p: Project): Project {
  return p.parent ? rootOf(p.parent) : p;
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

function example(k: string): string {
  return { id: 'login-page', title: 'Login page', status: 'idea', author: 'eli', priority: '1', blocked_from: 'executing' }[k] ?? 'value';
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
