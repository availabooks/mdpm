import { spawn, spawnSync } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { AgentDefinition, AgentPick, agentDefinitions, agentQueue, expandArgs, lastEntryIsClaim, modeFor, planClaim, writeBack } from './agent';
import { agentLog, readiness } from './body';
import { buildPrompt } from './instructions';
import { applyStatusDefaults, slugify } from './ops';
import { AgentMode, BLOCKED_STATUS, Task, Workspace } from './types';
import { previewTaskChange } from './validate';
import { findTask, loadWorkspace } from './workspace';

/*
 * `mdpm agent run`: pick a task, claim it, run an agent CLI on it in its own git worktree,
 * and record what happened. Design: docs/agent-workflow.md ("Running agents").
 */

export interface RunOptions {
  /** Workspace root (the main checkout); task state is written here. */
  root: string;
  agent?: string;
  /** Run this task instead of picking one ("Send to agent"). */
  task?: string;
  /** Stop after this many tasks (default 1). */
  maxTasks?: number;
  /** Overrides the project's `agent.maxTurns`. */
  maxTurns?: number;
  /** Print what would run; change nothing. */
  dryRun?: boolean;
  /** How agents call `mdpm`: the CLI script, run with `node` (put on the agent's PATH). */
  cli?: { node: string; script: string };
  /** Progress messages. */
  log?: (msg: string) => void;
  /** Where the agent's own output goes while it runs (default: inherited). */
  echo?: boolean;
}

export interface RunRecord {
  id: string;
  agent: string;
  task: string;
  mode: AgentMode;
  started: string;
  ended: string;
  durationMs: number;
  exitCode: number | null;
  /** Task status after the run. */
  status: string;
  branch: string;
  worktree?: string;
  sessionId?: string;
  costUsd?: number;
  limited?: boolean;
  resetsAt?: string;
  pr?: string;
  /** What the runner concluded, in words. */
  outcome: string;
}

export interface RunSummary {
  records: RunRecord[];
  /** Why the loop ended. */
  stopped: string;
}

export class RunnerError extends Error {}

/** The question a refined task is blocked on, so the person reviews it before an agent implements it. */
export const REVIEW_REFINEMENT = 'Review the refined description and acceptance criteria. Edit anything that is off, answer any other questions here, then Unblock (or move it to todo) to have it implemented.';

const LIMIT_PATTERNS = [/hit your (?:session |weekly |usage |opus |5-hour )?limit/i, /usage limit (?:reached|exceeded)/i, /(?:session|weekly|5-hour) limit (?:reached|exceeded)/i];

/** Recognizes a usage-limit message in an agent's output, and when the limit resets if it says so. */
export function detectLimit(output: string, now = new Date()): { limited: boolean; resetsAt?: Date; text?: string } {
  if (!LIMIT_PATTERNS.some((r) => r.test(output))) return { limited: false };
  const epoch = /limit reached\|(\d{10})/i.exec(output);
  if (epoch) return { limited: true, resetsAt: new Date(+epoch[1] * 1000), text: `epoch ${epoch[1]}` };
  const m = /resets?\s+(?:at\s+)?([^\n"·|]+)/i.exec(output);
  const text = m?.[1].trim().replace(/[.)]+$/, '');
  return { limited: true, resetsAt: text ? parseResetTime(text, now) : undefined, text };
}

/** Parses "3:45pm", "3pm", "15:45" (next occurrence) or an ISO date. Undefined when unrecognized. */
export function parseResetTime(text: string, now = new Date()): Date | undefined {
  const t = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text.trim());
  if (t && (t[2] || t[3])) {
    let h = +t[1] % (t[3] ? 12 : 24);
    if (t[3]?.toLowerCase() === 'pm') h += 12;
    const d = new Date(now);
    d.setHours(h, t[2] ? +t[2] : 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  const iso = Date.parse(text);
  return isNaN(iso) ? undefined : new Date(iso);
}

/** What Claude's JSON output tells us (the final result line of `json` or `stream-json`). Other agents report nothing. */
function parseClaudeJson(stdout: string): { sessionId?: string; costUsd?: number; maxTurns?: boolean; isError?: boolean; result?: string } {
  const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  const line = lines.reverse().find((l) => /"total_cost_usd"|"type"\s*:\s*"result"/.test(l)) ?? lines[0];
  if (!line) return {};
  try {
    const j = JSON.parse(line);
    return {
      sessionId: typeof j.session_id === 'string' ? j.session_id : undefined,
      costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
      maxTurns: j.subtype === 'error_max_turns' || j.terminal_reason === 'max_turns',
      isError: !!j.is_error,
      result: typeof j.result === 'string' ? j.result : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * A usage limit reported in Claude's stream: a `rate_limit_event` whose status is no longer
 * "allowed" (e.g. "rejected"), with the reset time as epoch seconds.
 */
export function streamLimit(stdout: string): { limited: boolean; resetsAt?: Date } {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.includes('rate_limit_event')) continue;
    try {
      const info = JSON.parse(line).rate_limit_info ?? {};
      if (typeof info.status === 'string' && !info.status.startsWith('allowed')) {
        return { limited: true, resetsAt: typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : undefined };
      }
      return { limited: false };
    } catch {
      // not a complete JSON line
    }
  }
  return { limited: false };
}

const clip = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** Turns one line of Claude's `stream-json` output into a readable progress line, or nothing. */
export function formatStreamLine(line: string): string | undefined {
  let ev: { type?: string; subtype?: string; session_id?: string; message?: { content?: unknown }; rate_limit_info?: { status?: string; resetsAt?: number } };
  try {
    ev = JSON.parse(line);
  } catch {
    return line.trim() ? line : undefined; // not JSON: show as is
  }
  if (ev.type === 'system' && ev.subtype === 'init') return `· session ${ev.session_id}`;
  if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.status && !ev.rate_limit_info.status.startsWith('allowed')) {
    const at = ev.rate_limit_info.resetsAt ? ` (resets ${new Date(ev.rate_limit_info.resetsAt * 1000).toLocaleString()})` : '';
    return `⚠ usage limit: ${ev.rate_limit_info.status}${at}`;
  }
  const content = Array.isArray(ev.message?.content) ? (ev.message!.content as Record<string, unknown>[]) : [];
  const out: string[] = [];
  for (const c of content) {
    if (ev.type === 'assistant' && c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
      out.push(c.text.trim());
    } else if (ev.type === 'assistant' && c.type === 'tool_use') {
      const input = (c.input ?? {}) as Record<string, unknown>;
      const detail = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt'].map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined;
      out.push(`→ ${c.name}${detail ? `: ${clip(detail)}` : ''}`);
    } else if (ev.type === 'user' && c.type === 'tool_result' && c.is_error) {
      const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
      out.push(`  ✗ ${clip(text)}`);
    }
  }
  return out.length ? out.join('\n') : undefined;
}

export function runId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `r-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
}

/** The top of the git repository containing `dir`, or undefined. */
export function gitRoot(dir: string): string | undefined {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.ok ? path.resolve(r.out) : undefined;
}

/** Folder for runner state (`.mdpm/` at the repo top), git-ignored by its own .gitignore. */
async function stateDir(repo: string): Promise<string> {
  const dir = path.join(repo, '.mdpm');
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!existsSync(ignore)) await fs.writeFile(ignore, '# Runner state (worktrees, run records); never committed.\n*\n');
  return dir;
}

/** Makes `mdpm` callable from the agent's shell, whether or not it is installed globally. */
async function writeShims(dir: string, cli: { node: string; script: string }): Promise<string> {
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin, { recursive: true });
  // ELECTRON_RUN_AS_NODE lets VS Code's bundled runtime act as node; plain node ignores it.
  await fs.writeFile(path.join(bin, 'mdpm'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${cli.node}" "${cli.script}" "$@"\n`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'mdpm.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${cli.node}" "${cli.script}" %*\r\n`);
  return bin;
}

/** Creates (or reuses) the worktree for a task on `branch`. */
function ensureWorktree(repo: string, worktree: string, branch: string): void {
  if (existsSync(path.join(worktree, '.git'))) return;
  const hasBranch = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  git(repo, ['worktree', 'prune']);
  const r = git(repo, hasBranch ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  if (!r.ok) {
    throw new RunnerError(
      `Could not create a git worktree for ${branch} at ${worktree} (${r.err}). If the branch is checked out elsewhere, run "git worktree list" and remove the stale one with "git worktree remove <path>".`,
    );
  }
}

/** Removes a worktree unless it has uncommitted changes. Returns whether it was removed. */
function removeWorktree(repo: string, worktree: string): boolean {
  if (!existsSync(worktree)) return true;
  if (git(worktree, ['status', '--porcelain']).out) return false;
  return git(repo, ['worktree', 'remove', worktree]).ok;
}

/** The session id of the agent's latest run on this task, for `resume`. */
async function lastSession(dir: string, task: string, agent: string): Promise<string | undefined> {
  const runs = path.join(dir, 'runs');
  const files = (await fs.readdir(runs).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort().reverse();
  for (const f of files) {
    try {
      const r = JSON.parse(await fs.readFile(path.join(runs, f), 'utf8')) as RunRecord;
      if (r.task === task && r.agent === agent && r.sessionId) return r.sessionId;
    } catch {
      // ignore unreadable records
    }
  }
  return undefined;
}

/**
 * On Windows, programs installed by npm are `.cmd` scripts, which can't be started without a
 * shell. This finds the real file on PATH and, for `.cmd`/`.bat`, runs it through cmd.exe with
 * every argument quoted, so no argument is ever interpreted by the shell.
 */
export function resolveCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  exists: (file: string) => boolean = existsSync,
): { file: string; args: string[]; verbatim?: boolean } {
  if (platform !== 'win32') return { file: cmd, args };
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = path.win32.isAbsolute(cmd) || cmd.includes('\\') || cmd.includes('/') ? [''] : (env[pathKey] ?? '').split(';').filter(Boolean);
  const hasExt = !!path.win32.extname(cmd);
  let found: string | undefined;
  for (const d of dirs) {
    for (const e of hasExt ? [''] : exts) {
      const candidate = d ? path.win32.join(d, cmd + e) : cmd + e;
      if (exists(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found) break;
  }
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { file: found ?? cmd, args };
  const quote = (a: string) => `"${a.replace(/"/g, '""')}"`.replace(/[()%!^&|<>]/g, '^$&');
  const line = [quote(found), ...args.map(quote)].join(' ');
  return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

interface AgentResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; echo: boolean; logFile: string; format?: (line: string) => string | undefined },
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const r = resolveCommand(cmd, args, opts.env);
    const child = spawn(r.file, r.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: r.verbatim });
    let stdout = '';
    let stderr = '';
    let partial = '';
    const show = (line: string) => {
      const text = opts.format!(line);
      if (text) process.stdout.write(text + '\n');
    };
    child.stdout.on('data', (d: Buffer) => {
      stdout += d;
      if (!opts.echo) return;
      if (!opts.format) return void process.stdout.write(d);
      // Show complete lines as they arrive; keep the rest for the next chunk.
      const lines = (partial + d.toString('utf8')).split(/\r?\n/);
      partial = lines.pop() ?? '';
      lines.forEach(show);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d;
      if (opts.echo) process.stderr.write(d);
    });
    child.on('error', (e) => {
      const hint = (e as NodeJS.ErrnoException).code === 'ENOENT' ? ` "${cmd}" was not found on PATH. Install it, or point the agent's "command" in the root .proj at the program.` : '';
      resolve({ exitCode: null, stdout, stderr: stderr + `${e.message}.${hint}` });
    });
    child.on('close', async (code) => {
      if (opts.echo && opts.format && partial) show(partial);
      await fs.writeFile(opts.logFile, `$ ${[cmd, ...args].map((a) => (a.length > 200 ? a.slice(0, 200) + '…' : a)).join(' ')}\n\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`).catch(() => {});
      resolve({ exitCode: code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // the agent may exit without reading stdin
    child.stdin.end(opts.stdin ?? '');
  });
}

function pushAndOpenPr(repo: string, worktree: string, branch: string, task: Task, summary: string, log: (m: string) => void): string | undefined {
  const remotes = git(repo, ['remote']).out.split(/\s+/).filter(Boolean);
  if (!remotes.length) {
    log(`No git remote, so ${branch} stays local. Merge it yourself, or add a remote to get pull requests.`);
    return undefined;
  }
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const push = git(worktree, ['push', '-u', remote, branch]);
  if (!push.ok) {
    log(`Could not push ${branch} to ${remote} (${push.err}). The branch is kept locally; push it yourself with "git push -u ${remote} ${branch}".`);
    return undefined;
  }
  const gh = (args: string[]) => spawnSync('gh', args, { cwd: worktree, encoding: 'utf8' });
  if (gh(['auth', 'status']).status !== 0) {
    log(`Pushed ${branch}. The GitHub CLI (gh) is missing or not logged in, so no pull request was opened; run "gh auth login" to get them automatically.`);
    return undefined;
  }
  const existing = gh(['pr', 'view', branch, '--json', 'url', '-q', '.url']);
  if (existing.status === 0 && existing.stdout.trim()) return existing.stdout.trim();
  const body = `${summary}\n\nTask: \`${path.relative(repo, task.file).split(path.sep).join('/')}\` (\`${task.id}\`). Opened by \`mdpm agent run\`.`;
  const pr = gh(['pr', 'create', '--head', branch, '--title', task.title, '--body', body]);
  if (pr.status !== 0) {
    log(`Pushed ${branch}, but "gh pr create" failed (${(pr.stderr || pr.stdout).trim()}). Open the pull request by hand.`);
    return undefined;
  }
  return pr.stdout.trim().split(/\s+/).find((s) => s.startsWith('http'));
}

function describeSkips(ws: Workspace, agent: string): string {
  const { skipped } = agentQueue(ws, agent);
  if (!skipped.length) {
    return `No tasks for ${agent}. Assign one with "mdpm set <task> owner=${agent}", or set "agent: {unassigned: true}" in a project's .proj to let ${agent} pick unassigned tasks.`;
  }
  return `No task ${agent} can work on right now:\n${skipped.map((s) => `  • ${s.task.id}: ${s.reason}`).join('\n')}`;
}

/** Runs the agent on up to `maxTasks` tasks, one after another. */
export async function runAgents(opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? ((m: string) => console.log(m));
  let ws = await loadWorkspace(opts.root);
  const defs = agentDefinitions(ws);
  const agentName = opts.agent ?? defs.default;
  const def: AgentDefinition | undefined = defs.agents[agentName];
  if (!def) {
    throw new RunnerError(`No agent "${agentName}". Known agents: ${Object.keys(defs.agents).join(', ')}. Define it under "agents:" in the root .proj.`);
  }
  const repo = gitRoot(ws.root);
  if (!repo) throw new RunnerError(`${ws.root} is not in a git repository. "mdpm agent run" puts each task on its own branch, so it needs one: run "git init" and make a first commit.`);
  if (!git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) throw new RunnerError('The repository has no commits yet, so there is nothing to branch from. Make a first commit, then try again.');

  const dir = await stateDir(repo);
  const limitFile = path.join(dir, 'limit.json');
  let limit: { agent?: string; until?: string } = {};
  try {
    if (existsSync(limitFile)) limit = JSON.parse(await fs.readFile(limitFile, 'utf8'));
  } catch {
    // a damaged record just means no known limit
  }
  if (!opts.dryRun && limit.agent === agentName && limit.until && new Date(limit.until) > new Date()) {
    return { records: [], stopped: `${agentName} hit its usage limit; it resets at ${new Date(limit.until).toLocaleString()}. Try again then, or delete ${limitFile} to try now.` };
  }

  const bin = opts.cli ? await writeShims(dir, opts.cli) : undefined;
  const maxTasks = opts.task ? 1 : Math.max(1, opts.maxTasks ?? 1);
  const tried = new Set<string>();
  const records: RunRecord[] = [];

  for (let n = 0; n < maxTasks; n++) {
    if (n > 0) ws = await loadWorkspace(ws.root);
    let pick: AgentPick | undefined;
    if (opts.task) {
      const task = findTask(ws, opts.task);
      if (!task) throw new RunnerError(`No task with id or path "${opts.task}". Run "mdpm list" to see task ids.`);
      const mode = modeFor(task);
      if (!mode) throw new RunnerError(`"${task.id}" is "${task.status}"; agents only work on backlog, todo and in-progress tasks.${task.status === 'blocked' ? ' Answer its questions and move it back to todo first.' : ''}`);
      if (!task.home.agent.modes.includes(mode)) throw new RunnerError(`"${task.id}" needs "${mode}" mode, which project "${task.home.name}" doesn't allow (agent.modes in its .proj).`);
      pick = { task, mode, assigned: task.owner === agentName, readiness: readiness(task.body) };
    } else {
      pick = agentQueue(ws, agentName, { exclude: tried }).picks[0];
      if (!pick) return { records, stopped: n === 0 ? describeSkips(ws, agentName) : `No more tasks for ${agentName}.` };
    }
    const { task, mode } = pick;
    tried.add(task.id);

    const id = runId();
    const branch = `agent/${slugify(task.id) || 'task'}`;
    const worktree = path.join(dir, 'worktrees', slugify(task.id) || 'task');
    const settings = task.home.agent;
    const sessionId = mode === 'resume' && def.resume ? await lastSession(dir, task.id, agentName) : undefined;
    const prompt = buildPrompt({ agent: agentName, mode, taskId: task.id, taskFile: task.file, taskText: await fs.readFile(task.file, 'utf8'), root: ws.root, worktree, branch });
    const promptFile = path.join(dir, 'runs', `${id}.prompt.md`);
    const values = {
      prompt,
      promptFile,
      taskFile: task.file,
      taskId: task.id,
      worktree,
      root: ws.root,
      maxTurns: String(opts.maxTurns ?? settings.maxTurns),
      allowedTools: settings.allowedTools,
      sessionId: sessionId ?? '',
    };
    const args = expandArgs([...def.command, ...(sessionId ? def.resume ?? [] : [])], values);

    log(`▶ ${task.id} (${mode}) with ${agentName} on ${branch}`);
    if (opts.dryRun) {
      const shown = args.map((a) => (a === prompt ? '<prompt>' : /\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
      log(`  worktree: ${worktree}\n  command:  ${shown}${def.stdin ? ' < <prompt>' : ''}\n\n${prompt}`);
      continue;
    }

    const claim = planClaim(task, agentName, id, { force: !!opts.task });
    const errors = previewTaskChange(ws, task, claim.changes).filter((i) => i.level === 'error');
    if (errors.length) throw new RunnerError(`Claiming "${task.id}" would make it invalid, so it was not run:\n${errors.map((i) => `  • ${i.message}`).join('\n')}`);
    await writeBack(task.file, claim);

    const started = new Date();
    let result: AgentResult;
    try {
      ensureWorktree(repo, worktree, branch);
      await fs.writeFile(promptFile, prompt);
      const env: NodeJS.ProcessEnv = { ...process.env, MDPM_AGENT: agentName, MDPM_TASK: task.id, MDPM_ROOT: ws.root, MDPM_RUN: id };
      delete env.ELECTRON_RUN_AS_NODE; // set when launched from VS Code; the shims set it again for mdpm only
      if (bin) {
        const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
        env[key] = `${bin}${path.delimiter}${env[key] ?? ''}`;
      }
      result = await runProcess(args[0], args.slice(1), {
        cwd: worktree,
        env,
        stdin: def.stdin ? prompt : undefined,
        echo: opts.echo ?? true,
        logFile: path.join(dir, 'runs', `${id}.log`),
        format: def.output === 'claude-stream' ? formatStreamLine : undefined,
      });
    } catch (e) {
      await writeBack(task.file, { changes: {}, log: `run ${id} failed to start: ${(e as Error).message}`, by: 'mdpm' });
      throw e;
    }
    const ended = new Date();

    const parsed = def.output === 'claude-json' || def.output === 'claude-stream' ? parseClaudeJson(result.stdout) : {};
    const streamed = def.output === 'claude-stream' ? streamLimit(result.stdout) : { limited: false };
    const texts = detectLimit(`${parsed.result ?? ''}\n${result.stderr}${def.output === 'text' ? `\n${result.stdout}` : ''}`, ended);
    const lim = streamed.limited ? { ...texts, limited: true, resetsAt: streamed.resetsAt ?? texts.resetsAt, text: streamed.resetsAt?.toLocaleString() ?? texts.text } : texts;
    ws = await loadWorkspace(ws.root);
    const after = findTask(ws, task.file) ?? task;
    const record: RunRecord = {
      id,
      agent: agentName,
      task: task.id,
      mode,
      started: started.toISOString(),
      ended: ended.toISOString(),
      durationMs: ended.getTime() - started.getTime(),
      exitCode: result.exitCode,
      status: after.status,
      branch,
      worktree,
      sessionId: parsed.sessionId,
      costUsd: parsed.costUsd,
      outcome: '',
    };

    const note = async (text: string) => writeBack(after.file, { changes: {}, log: text, by: 'mdpm' });
    const ahead = Number(git(repo, ['rev-list', '--count', `HEAD..${branch}`]).out) || 0;

    if (lim.limited) {
      record.limited = true;
      record.resetsAt = lim.resetsAt?.toISOString() ?? lim.text;
      record.outcome = 'usage limit';
      await note(`run ${id} stopped: ${agentName} hit its usage limit${lim.text ? ` (resets ${lim.text})` : ''}. The task stays ${after.status} and resumes on the next run.`);
      if (lim.resetsAt) await fs.writeFile(limitFile, JSON.stringify({ agent: agentName, until: lim.resetsAt.toISOString(), run: id }, null, 2));
    } else if (mode === 'refine' && !lastEntryIsClaim(after, agentName) && after.status !== BLOCKED_STATUS && after.home.statuses.includes(BLOCKED_STATUS)) {
      // A refined task always comes back to the person, who checks it before an agent implements it.
      await writeBack(after.file, {
        changes: applyStatusDefaults(after, { status: BLOCKED_STATUS }),
        questions: [REVIEW_REFINEMENT],
        log: `run ${id}: refinement done; blocked so you can review it`,
        by: 'mdpm',
      });
      if (!ahead && removeWorktree(repo, worktree)) {
        git(repo, ['branch', '-d', branch]);
        record.worktree = undefined;
      }
      record.outcome = 'refined';
    } else if (after.status === 'review') {
      const summary = agentLog(after.body).filter((e) => e.by === agentName).at(-1)?.text.replace(/^handed off for review:\s*/i, '') ?? `Work on ${task.title}`;
      const changes: Record<string, unknown> = {};
      if (!after.meta.branch && ahead) changes.branch = branch;
      if (ahead) {
        const pr = pushAndOpenPr(repo, worktree, branch, after, summary, log);
        if (pr && pr !== after.meta.pr) {
          changes.pr = pr;
          record.pr = pr;
        }
      }
      const removed = removeWorktree(repo, worktree);
      if (!removed) log(`Kept ${worktree}: it has uncommitted changes. Commit or discard them, then run "git worktree remove ${worktree}".`);
      else record.worktree = undefined;
      if (!ahead) git(repo, ['branch', '-d', branch]);
      const text = ahead ? (record.pr ? `opened ${record.pr}` : `work is on branch ${branch}`) : 'handed off with no commits on its branch';
      await writeBack(after.file, { changes, log: `run ${id}: ${text}${removed ? '' : '; worktree kept because it has uncommitted changes'}`, by: 'mdpm' });
      record.outcome = 'handed off';
    } else if (mode === 'refine' ? lastEntryIsClaim(after, agentName) : after.status === 'in-progress') {
      const why = parsed.maxTurns ? `reached the turn limit (${values.maxTurns})` : `exited (code ${result.exitCode ?? 'none'}) without handing off, blocking or logging progress`;
      const tail = (result.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
      await note(`run ${id}: ${agentName} ${why}${tail && !parsed.maxTurns ? `: ${tail}` : ''}. Left ${after.status} so the next run resumes it.`);
      record.outcome = parsed.maxTurns ? 'max turns' : 'no handoff';
    } else {
      record.outcome = after.status;
      if (mode === 'refine' && !ahead && removeWorktree(repo, worktree)) {
        git(repo, ['branch', '-d', branch]);
        record.worktree = undefined;
      }
    }

    record.status = (findTask(await loadWorkspace(ws.root), task.file) ?? after).status;
    await fs.writeFile(path.join(dir, 'runs', `${id}.json`), JSON.stringify(record, null, 2));
    records.push(record);
    log(`■ ${task.id}: ${record.outcome} (status ${record.status}, ${Math.round(record.durationMs / 1000)}s${record.costUsd !== undefined ? `, $${record.costUsd.toFixed(2)}` : ''}${record.pr ? `, ${record.pr}` : ''})`);
    if (record.limited) return { records, stopped: `${agentName} hit its usage limit${lim.text ? `; it resets ${lim.text}` : ''}.` };
  }
  return { records, stopped: opts.dryRun ? 'Dry run: nothing was changed.' : `Reached the limit of ${maxTasks} task${maxTasks > 1 ? 's' : ''}.` };
}
