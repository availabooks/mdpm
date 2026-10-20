import { promises as fs } from 'fs';
import { LOG_HEADING, QUESTIONS_HEADING, appendToSection, formatLogEntry, formatQuestion } from './body';
import { splitFrontMatter, updateFrontMatter } from './frontmatter';
import { Task, Workspace } from './types';

/*
 * Agent CLIs (presets and `agents:` in the root .proj) and write-backs: front matter changes
 * plus lines added to an idea's `## Questions` and `## Log`. Design: docs/agent-workflow.md.
 */

/** How an agent CLI is run. Arguments may contain placeholders such as `{prompt}`; see `expandArgs`. */
export interface AgentDefinition {
  name: string;
  /** Program and arguments. Never run through a shell. */
  command: string[];
  /** Send the prompt on stdin instead of as an argument. */
  stdin?: boolean;
  /** Command for an interactive session started by a person (`mdpm agent continue`); `{prompt}` is the opening message. */
  interactive?: string[];
  /** Command that reopens the latest interactive session in the agent worktree, when the agent can. */
  continueInteractive?: string[];
  /** Extra arguments to continue an earlier session (resuming an execution), e.g. `[--resume, "{sessionId}"]`. */
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
    continueInteractive: ['claude', '--resume', '{sessionId}', '--add-dir', '{root}', '--allowedTools', '{allowedTools}'],
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

const PRIORITY_WORDS: Record<string, number> = { critical: 0, urgent: 0, high: 1, medium: 2, normal: 2, low: 3 };

/** Numeric priority: lower is more urgent; words map to numbers; no priority sorts last. */
export function priorityRank(p: string | number | undefined): number {
  if (typeof p === 'number') return p;
  if (p === undefined) return 99;
  const word = PRIORITY_WORDS[p.toLowerCase()];
  if (word !== undefined) return word;
  const n = parseFloat(p.replace(/^p/i, ''));
  return isNaN(n) ? 50 : n;
}

/** A change to an idea file: front matter changes plus lines added to body sections. */
export interface WriteBack {
  changes: Record<string, unknown>;
  /** Text of a `## Log` entry. */
  log?: string;
  /** Questions added to `## Questions` as open checkboxes. */
  questions?: string[];
  /** Name the entries are signed with. */
  by: string;
  /** Rewrites the body before the sections are appended (e.g. ticking answered questions). */
  body?: (body: string) => string;
}

/** Applies a write-back to the text of an idea file. */
export function applyWriteBack(text: string, wb: WriteBack, now = new Date()): string {
  const out = Object.keys(wb.changes).length ? updateFrontMatter(text, wb.changes) : text;
  const split = splitFrontMatter(out);
  if (!split) throw new Error('the file has no front matter, so it is not an idea.');
  return out.slice(0, out.length - split.body.length) + appendSections(split.body, wb, now);
}

function appendSections(body: string, wb: WriteBack, now: Date): string {
  if (wb.body) body = wb.body(body);
  if (wb.questions?.length) body = appendToSection(body, QUESTIONS_HEADING, wb.questions.flatMap((q) => formatQuestion(wb.by, q, now)));
  if (wb.log) body = appendToSection(body, LOG_HEADING, formatLogEntry(wb.by, wb.log, now));
  return body;
}

/** The idea's body after a write-back, for validating it before writing. */
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

/** Thrown for a flow command that isn't allowed; the message says what to do instead. */
export class AgentError extends Error {}
