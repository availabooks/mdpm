import { promises as fs } from 'fs';
import { AGENT_LOG_HEADING, QUESTIONS_HEADING, Readiness, agentLog, appendToSection, formatLogEntry, formatQuestion, readiness } from './body';
import { splitFrontMatter, updateFrontMatter } from './frontmatter';
import { applyStatusDefaults, isFinalStatus } from './ops';
import { AgentMode, BLOCKED_STATUS, Task, Workspace } from './types';

/*
 * The agent protocol: which task an agent works on next (`mdpm next`), and the write-backs
 * agents make (`claim`, `log`, `block`, `handoff`, `release`). Design: docs/agent-workflow.md.
 */

export const STATUS = { backlog: 'backlog', todo: 'todo', inProgress: 'in-progress', blocked: BLOCKED_STATUS, review: 'review' } as const;

/** How an agent CLI is run. Arguments may contain placeholders such as `{prompt}`; see `expandArgs`. */
export interface AgentDefinition {
  name: string;
  /** Program and arguments. Never run through a shell. */
  command: string[];
  /** Send the prompt on stdin instead of as an argument. */
  stdin?: boolean;
  /** Command for an interactive session started by a person (`mdpm agent continue`); `{prompt}` is the opening message. */
  interactive?: string[];
  /** Command that reopens the latest interactive session in the task's worktree, when the agent can. */
  continueInteractive?: string[];
  /** Extra arguments to continue an earlier session (`resume` mode), e.g. `[--resume, "{sessionId}"]`. */
  resume?: string[];
  /**
   * How to read the agent's stdout: Claude's `--output-format stream-json` (shown live as
   * readable steps), Claude's `--output-format json` (one result at the end), or plain text.
   */
  output?: AgentOutput;
}

export type AgentOutput = 'claude-stream' | 'claude-json' | 'text';
export const AGENT_OUTPUTS: AgentOutput[] = ['claude-stream', 'claude-json', 'text'];

/** Built-in agents. A root `.proj` can override them or add more under `agents:`. */
export const AGENT_PRESETS: Record<string, AgentDefinition> = {
  claude: {
    name: 'claude',
    command: [
      'claude', '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--max-turns', '{maxTurns}', '--add-dir', '{root}', '--allowedTools', '{allowedTools}',
    ],
    stdin: true,
    resume: ['--resume', '{sessionId}'],
    output: 'claude-stream',
    // The prompt goes first: --allowedTools takes a list and would swallow a trailing argument.
    interactive: ['claude', '{prompt}', '--add-dir', '{root}', '--allowedTools', '{allowedTools}'],
    continueInteractive: ['claude', '--continue', '--add-dir', '{root}', '--allowedTools', '{allowedTools}'],
  },
  codex: { name: 'codex', command: ['codex', 'exec', '-'], stdin: true, output: 'text', interactive: ['codex', '{prompt}'] },
  cursor: { name: 'cursor', command: ['cursor-agent', '-p', '{prompt}'], output: 'text', interactive: ['cursor-agent', '{prompt}'] },
};

export const DEFAULT_AGENT = 'claude';

export const PLACEHOLDERS = ['prompt', 'promptFile', 'taskFile', 'taskId', 'worktree', 'root', 'maxTurns', 'allowedTools', 'sessionId'];

/** Agents defined for a workspace: the presets, plus or overridden by `agents:` in root `.proj` files. */
export function agentDefinitions(ws: Workspace): { default: string; agents: Record<string, AgentDefinition> } {
  const agents: Record<string, AgentDefinition> = { ...AGENT_PRESETS };
  let def = DEFAULT_AGENT;
  for (const p of ws.projects.filter((p) => !p.parent)) {
    const raw = p.meta.agents;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    for (const [name, v] of Object.entries(raw)) {
      if (name === 'default') {
        if (typeof v === 'string' && v.trim()) def = v.trim();
        continue;
      }
      const parsed = parseAgentDefinition(name, v);
      if (parsed) agents[name] = parsed;
    }
  }
  return { default: def, agents };
}

/** Reads one `agents:` entry: a list of arguments, or `{command, stdin, resume, output, interactive, continueInteractive}`. Undefined when malformed. */
export function parseAgentDefinition(name: string, v: unknown): AgentDefinition | undefined {
  const isArgs = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every((a) => typeof a === 'string' || typeof a === 'number');
  if (isArgs(v)) return { name, command: v.map(String), output: 'text' };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const base = AGENT_PRESETS[name];
  if (o.command !== undefined && !isArgs(o.command)) return undefined;
  const command = o.command !== undefined ? (o.command as unknown[]).map(String) : base?.command;
  if (!command) return undefined;
  return {
    name,
    command,
    stdin: typeof o.stdin === 'boolean' ? o.stdin : o.command !== undefined ? false : base?.stdin,
    resume: isArgs(o.resume) ? o.resume.map(String) : o.command !== undefined ? undefined : base?.resume,
    interactive: isArgs(o.interactive) ? o.interactive.map(String) : base?.interactive,
    continueInteractive: isArgs(o.continueInteractive) ? o.continueInteractive.map(String) : base?.continueInteractive,
    output: AGENT_OUTPUTS.includes(o.output as AgentOutput) ? (o.output as AgentOutput) : o.command !== undefined ? 'text' : base?.output,
  };
}

/** Names that count as agents (for badges and agent-only rules). */
export function agentNames(ws: Workspace): Set<string> {
  return new Set(Object.keys(agentDefinitions(ws).agents));
}

/** Expands placeholders. An argument that is exactly `{allowedTools}` becomes one argument per tool. */
export function expandArgs(args: string[], values: Partial<Record<string, string | string[]>>): string[] {
  return args.flatMap((a) => {
    const whole = /^\{(\w+)\}$/.exec(a);
    if (whole && Array.isArray(values[whole[1]])) return values[whole[1]] as string[];
    return [a.replace(/\{(\w+)\}/g, (m, k: string) => (values[k] === undefined ? m : ([] as string[]).concat(values[k]!).join(',')))];
  });
}

export interface AgentPick {
  task: Task;
  mode: AgentMode;
  /** The task is assigned to this agent (rather than picked up unassigned). */
  assigned: boolean;
  readiness: Readiness;
}

export interface AgentSkip {
  task: Task;
  /** Why it wasn't picked, phrased so the person knows what to change. */
  reason: string;
}

const PRIORITY_WORDS: Record<string, number> = { critical: 0, urgent: 0, high: 1, medium: 2, normal: 2, low: 3 };
const MODE_RANK: Record<AgentMode, number> = { resume: 0, implement: 1, refine: 2 };

/** Numeric priority: lower is more urgent; words map to numbers; no priority sorts last. */
export function priorityRank(p: string | number | undefined): number {
  if (typeof p === 'number') return p;
  if (p === undefined) return 99;
  const word = PRIORITY_WORDS[p.toLowerCase()];
  if (word !== undefined) return word;
  const n = parseFloat(p.replace(/^p/i, ''));
  return isNaN(n) ? 50 : n;
}

/** True when the task's last agent-log entry is this agent releasing it, so it waits for the person. */
function releasedBy(task: Task, agent: string): boolean {
  const last = agentLog(task.body).at(-1);
  return !!last && last.by === agent && /^released\b/i.test(last.text);
}

/**
 * Every task this agent could work on, best first, and the agent's tasks it can't work on with
 * the reason. Unassigned tasks are only considered in projects with `agent.unassigned: true`.
 */
export function agentQueue(ws: Workspace, agent: string, opts: { exclude?: Set<string> } = {}): { picks: AgentPick[]; skipped: AgentSkip[] } {
  const picks: AgentPick[] = [];
  const skipped: AgentSkip[] = [];
  const byId = new Map(ws.tasks.map((t) => [t.id, t]));
  const errorFiles = new Set(ws.issues.filter((i) => i.level === 'error').map((i) => i.file));

  for (const task of ws.tasks) {
    if (opts.exclude?.has(task.id)) continue;
    const settings = task.home.agent;
    const assigned = task.owner === agent;
    if (!assigned && !(task.owner === undefined && settings.unassigned)) continue;
    const skip = (reason: string) => skipped.push({ task, reason });

    if (!settings.enabled) {
      skip(`agents are disabled in project "${task.home.name}" (agent.enabled: false). Set it to true in its .proj to let agents work there.`);
      continue;
    }
    const ready = readiness(task.body);
    let mode: AgentMode;
    if (task.status === STATUS.inProgress) {
      if (!assigned) continue; // unassigned but in progress: someone is on it without saying so
      mode = 'resume';
    } else if (task.status === STATUS.todo) {
      mode = ready.ready ? 'implement' : 'refine';
    } else if (task.status === STATUS.backlog) {
      mode = 'refine';
    } else {
      if (assigned && !isFinalStatus(task.home, task.status)) {
        skip(task.status === BLOCKED_STATUS ? 'it is blocked. Answer its open questions, then move it back to todo.' : `it is "${task.status}"; agents only pick backlog, todo and their own in-progress tasks.`);
      }
      continue;
    }
    if (!settings.modes.includes(mode)) {
      const why = mode === 'refine' && task.status === STATUS.todo ? ` (it is not ready: add ${ready.missing})` : '';
      skip(`it needs "${mode}" mode${why}, which project "${task.home.name}" doesn't allow (agent.modes: ${settings.modes.join(', ')}).`);
      continue;
    }
    if (errorFiles.has(task.file)) {
      skip('it has validation errors. Run "mdpm check" and fix them.');
      continue;
    }
    const open = task.dependsOn.filter((d) => {
      const dep = byId.get(d);
      return !dep || !isFinalStatus(dep.home, dep.status);
    });
    if (open.length) {
      skip(`it depends on ${open.map((d) => `"${d}"`).join(', ')}, which ${open.length > 1 ? 'are' : 'is'} not done yet.`);
      continue;
    }
    if (releasedBy(task, agent)) {
      skip(`${agent} released it. Read the last "Agent log" entry; to queue it again, add a log entry (mdpm log ${task.id} "…") or reassign it.`);
      continue;
    }
    picks.push({ task, mode, assigned, readiness: ready });
  }

  picks.sort(
    (a, b) =>
      MODE_RANK[a.mode] - MODE_RANK[b.mode] ||
      Number(b.assigned) - Number(a.assigned) ||
      priorityRank(a.task.priority) - priorityRank(b.task.priority) ||
      (a.task.end ?? '9999').localeCompare(b.task.end ?? '9999') ||
      (a.task.created ?? '9999').localeCompare(b.task.created ?? '9999') ||
      a.task.id.localeCompare(b.task.id),
  );
  return { picks, skipped };
}

/** The mode an agent would work on a specific task in, ignoring ownership and ranking (for `--task`). */
export function modeFor(task: Task): AgentMode | undefined {
  if (task.status === STATUS.inProgress) return 'resume';
  if (task.status === STATUS.todo) return readiness(task.body).ready ? 'implement' : 'refine';
  if (task.status === STATUS.backlog) return 'refine';
  return undefined;
}

/** A change to a task file: front matter changes plus lines added to body sections. */
export interface WriteBack {
  changes: Record<string, unknown>;
  /** Text of an `## Agent log` entry. */
  log?: string;
  /** Questions added to `## Questions` as open checkboxes. */
  questions?: string[];
  /** Name the entries are signed with. */
  by: string;
}

/** Applies a write-back to the text of a task file. */
export function applyWriteBack(text: string, wb: WriteBack, now = new Date()): string {
  const out = Object.keys(wb.changes).length ? updateFrontMatter(text, wb.changes) : text;
  const split = splitFrontMatter(out);
  if (!split) throw new Error('the file has no front matter, so it is not a task.');
  return out.slice(0, out.length - split.body.length) + appendSections(split.body, wb, now);
}

function appendSections(body: string, wb: WriteBack, now: Date): string {
  if (wb.questions?.length) body = appendToSection(body, QUESTIONS_HEADING, wb.questions.flatMap((q) => formatQuestion(wb.by, q, now)));
  if (wb.log) body = appendToSection(body, AGENT_LOG_HEADING, formatLogEntry(wb.by, wb.log, now));
  return body;
}

/** The task body after a write-back, for validating it before writing. */
export function bodyAfter(task: Task, wb: WriteBack, now = new Date()): string {
  return appendSections(task.body, wb, now);
}

export async function writeBack(file: string, wb: WriteBack): Promise<void> {
  const text = await fs.readFile(file, 'utf8');
  let updated: string;
  try {
    updated = applyWriteBack(text, wb);
  } catch (e) {
    throw new Error(`Cannot update ${file}: ${(e as Error).message}`);
  }
  await fs.writeFile(file, updated, 'utf8');
}

/** Thrown for a write-back that isn't allowed; the message says what to do instead. */
export class AgentError extends Error {}

function needStatus(task: Task, status: string, purpose: string) {
  if (!task.home.statuses.includes(status)) {
    throw new AgentError(`project "${task.home.name}" has no "${status}" status, which ${purpose}. Add "${status}" to "statuses" in ${task.home.file}.`);
  }
}

/** `mdpm claim`: take the task. Refinement keeps the status; other work moves it to in-progress. */
export function planClaim(task: Task, agent: string, runId: string, opts: { force?: boolean } = {}): WriteBack {
  if (task.owner && task.owner !== agent && !opts.force) {
    throw new AgentError(
      `"${task.id}" is ${task.status === STATUS.inProgress ? 'already claimed by' : 'assigned to'} ${task.owner}. Pick another task (mdpm next --agent ${agent}), or add --force to take it over.`,
    );
  }
  const mode = modeFor(task);
  if (!mode) {
    const fix = task.status === BLOCKED_STATUS ? 'Answer its questions and move it back to todo first.' : 'Agents only take backlog, todo and in-progress tasks.';
    throw new AgentError(`"${task.id}" is "${task.status}", so it can't be claimed. ${fix}`);
  }
  const run = runId ? ` (run ${runId})` : '';
  if (mode === 'refine') return { changes: { owner: agent }, log: `claimed for refinement${run}`, by: agent };
  needStatus(task, STATUS.inProgress, 'claiming a task moves it to');
  if (mode === 'resume' && task.owner === agent) return { changes: {}, log: `resumed${run}`, by: agent };
  return { changes: applyStatusDefaults(task, { status: STATUS.inProgress, owner: agent }), log: `claimed${run}`, by: agent };
}

/** `mdpm block`: the task can't move without answers. */
export function planBlock(task: Task, agent: string, questions: string[]): WriteBack {
  if (!questions.some((q) => q.trim())) throw new AgentError('give at least one question, e.g. mdpm block <task> "Should the export include archived tasks?"');
  needStatus(task, BLOCKED_STATUS, 'blocking a task moves it to');
  const n = questions.length;
  return {
    changes: applyStatusDefaults(task, { status: BLOCKED_STATUS }),
    questions,
    log: `blocked on ${n} question${n > 1 ? 's' : ''} (see Questions)`,
    by: agent,
  };
}

/** `mdpm handoff`: the work is ready for the person to review. */
export function planHandoff(task: Task, agent: string, summary: string, opts: { branch?: string; pr?: string } = {}): WriteBack {
  if (!summary.trim()) throw new AgentError('give a summary of what was done and how it was verified, e.g. mdpm handoff <task> "Added CSV export; npm test passes"');
  needStatus(task, STATUS.review, 'handing off moves a task to');
  const changes: Record<string, unknown> = { status: STATUS.review };
  if (opts.branch) changes.branch = opts.branch;
  if (opts.pr) changes.pr = opts.pr;
  return { changes: applyStatusDefaults(task, changes), log: `handed off for review: ${summary}`, by: agent };
}

/** `mdpm release`: give the task back without doing it. */
export function planRelease(task: Task, agent: string, reason: string): WriteBack {
  if (!reason.trim()) throw new AgentError('say why the task is being given back, e.g. mdpm release <task> "Needs a product decision first"');
  needStatus(task, STATUS.todo, 'releasing a task moves it back to');
  return { changes: { status: STATUS.todo }, log: `released: ${reason}`, by: agent };
}

/**
 * Guard rails while `MDPM_AGENT` is set: an agent may only change tasks it owns (claimed), and
 * may never move a task to the final ("done") status. Returns why the change is refused.
 */
export function agentGuard(task: Task, changes: Record<string, unknown>, agent: string): string | undefined {
  if (typeof changes.status === 'string' && isFinalStatus(task.home, changes.status)) {
    return `agents don't mark tasks "${changes.status}"; a person does that after review. Run "mdpm handoff ${task.id} \\"<summary>\\"" instead.`;
  }
  if (task.owner !== agent) {
    return `${agent} hasn't claimed "${task.id}" (owner: ${task.owner ?? 'nobody'}). Run "mdpm claim ${task.id}" first. If you are a person, unset MDPM_AGENT.`;
  }
  return undefined;
}

/**
 * For the Stop hook: true when the agent's last log entry on the task is its claim, i.e. it is
 * about to stop without logging progress, blocking or handing off.
 */
export function lastEntryIsClaim(task: Task, agent: string): boolean {
  const last = agentLog(task.body).at(-1);
  return !!last && last.by === agent && /^(claimed|resumed)\b/i.test(last.text);
}
