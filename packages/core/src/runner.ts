import { spawn, spawnSync } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { AgentDefinition, WriteBack, agentDefinitions, expandArgs, writeBack } from './agent';
import { logEntries, planCheck } from './body';
import { activityVerb, ago, markActive, readActive } from './activity';
import { FlowPick, flowQueue, ideaBranch, modeFor, planBlock, planPropose, planStart } from './flow';
import { buildContinuePrompt, buildPrompt } from './instructions';
import { AgentMode, BLOCKED_STATUS, Task, Workspace } from './types';
import { previewTaskChange } from './validate';
import { findTask, loadWorkspace } from './workspace';

/*
 * `mdpm agent run`: do the next thing in the flow (execute the idea in the slot or the top
 * approved plan, else plan the top idea) in the one agent worktree, and record what happened.
 * One run at a time per workspace. Design: docs/agent-workflow.md ("Running").
 */

export interface RunOptions {
  /** Workspace root (the main checkout); idea state is written here. */
  root: string;
  agent?: string;
  /** Plan or execute this idea instead of picking one. */
  idea?: string;
  /** Keep going until nothing is left to do or usage runs out (default: one run). */
  untilIdle?: boolean;
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
  /** Idea id. */
  idea: string;
  mode: AgentMode;
  resume?: boolean;
  started: string;
  ended: string;
  durationMs: number;
  exitCode: number | null;
  /** Idea status after the run. */
  status: string;
  /** The idea's branch (execute), or the default branch read detached (plan). */
  branch: string;
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
  /** Why the runner stopped. */
  stopped: string;
}

export class RunnerError extends Error {}

/** Folder of the one worktree every run uses, under the state folder (`.mdpm/agent`). */
export const AGENT_WORKTREE = 'agent';

/** Message for a second run (or chat) while one is going: one run at a time per workspace. */
function busyMessage(r: { agent: string; task: string; mode: Parameters<typeof activityVerb>[0]; started: string; pid: number }): string {
  return `${r.agent} is already ${activityVerb(r.mode)} "${r.task}" (started ${ago(r.started)} ago, pid ${r.pid}), and only one run happens at a time. Wait for it to finish, or stop that process first; a run that died is ignored after a minute.`;
}

/** The question a plan run is blocked on when it ended without writing a plan. */
export const NO_PLAN_QUESTION = 'The plan run ended without a plan (no acceptance criteria were written). Add anything that would help to the Idea section, then unblock it to have it planned again.';

/** Runs per idea in one `--until-idle` loop before it is left for the next loop (stops endless resumes). */
const MAX_RUNS_PER_IDEA = 3;

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

/** True when the repository has a local branch `name`. */
export function branchExists(repo: string, name: string): boolean {
  return git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok;
}

/**
 * The branch ideas start from and plans are read against: the remote's default branch when it
 * exists locally, else `main` or `master`, else whatever the main checkout has checked out.
 */
export function defaultBranch(repo: string): string {
  const remote = git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const candidates = [remote.ok ? remote.out.replace(/^origin\//, '') : '', 'main', 'master'].filter(Boolean);
  const local = candidates.find((b) => branchExists(repo, b));
  if (local) return local;
  if (remote.ok) return remote.out;
  return git(repo, ['branch', '--show-current']).out || 'HEAD';
}

/** Folder for runner state (`.mdpm/` at the repo top), git-ignored by its own .gitignore. */
async function stateDir(repo: string): Promise<string> {
  const dir = path.join(repo, '.mdpm');
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!existsSync(ignore)) await fs.writeFile(ignore, '# Runner state (the agent worktree, run records); never committed.\n*\n');
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

/** Creates the agent worktree (detached at `base`) the first time; reuses it afterwards. */
function ensureAgentWorktree(repo: string, worktree: string, base: string): void {
  if (existsSync(path.join(worktree, '.git'))) return;
  git(repo, ['worktree', 'prune']);
  const r = git(repo, ['worktree', 'add', '--detach', worktree, base]);
  if (!r.ok) {
    throw new RunnerError(`Could not create the agent worktree at ${worktree} from ${base} (${r.err}). Run "git worktree list", remove a stale entry with "git worktree remove <path>", then try again.`);
  }
}

/**
 * Keeps whatever the worktree has uncommitted before it switches: committed to the branch it is
 * on (`wip: …`), or stashed when it is detached (a plan run should not have changed anything).
 * Returns what was done, for the log.
 */
function saveWork(worktree: string, message: string): string | undefined {
  if (!git(worktree, ['status', '--porcelain']).out) return undefined;
  const branch = git(worktree, ['branch', '--show-current']).out;
  if (!branch) {
    const r = git(worktree, ['stash', 'push', '--include-untracked', '-m', `mdpm: ${message}`]);
    if (!r.ok) throw new RunnerError(`The agent worktree ${worktree} has uncommitted changes that could not be stashed (${r.err}). Commit or discard them there, then try again.`);
    return `stashed uncommitted changes in the agent worktree ("git -C ${worktree} stash list" shows them)`;
  }
  const add = git(worktree, ['add', '-A']);
  const commit = add.ok ? git(worktree, ['commit', '--no-verify', '-qm', `wip: ${message}`]) : add;
  if (!commit.ok) {
    throw new RunnerError(`The agent worktree has uncommitted changes on ${branch} that could not be committed (${commit.err}). If git asks who you are, set user.name and user.email; otherwise commit or discard the changes in ${worktree}, then try again.`);
  }
  return `committed uncommitted changes to ${branch} as "wip: ${message}"`;
}

/** Puts the agent worktree on `branch` (created from `base` if new), or detached at `base` when `branch` is undefined. */
function switchWorktree(repo: string, worktree: string, base: string, branch: string | undefined): void {
  const current = git(worktree, ['branch', '--show-current']).out;
  if (branch && current === branch) return;
  const args = !branch ? ['checkout', '--quiet', '--detach', base] : branchExists(repo, branch) ? ['checkout', '--quiet', branch] : ['checkout', '--quiet', '-b', branch, base];
  const r = git(worktree, args);
  if (!r.ok) {
    const elsewhere = /already (checked out|used by worktree) at '([^']+)'/.exec(r.err)?.[2];
    throw new RunnerError(
      elsewhere
        ? `${branch} is checked out in ${elsewhere}, so the agent can't work on it. Switch that checkout to another branch (git switch -), then try again.`
        : `Could not check out ${branch ?? base} in the agent worktree (${r.err}). Fix it in ${worktree} (git status), then try again.`,
    );
  }
}

/** Saves the worktree's work (see `saveWork`) and switches it; returns the save note, if any. */
function prepareWorktree(ws: Workspace, repo: string, worktree: string, base: string, branch: string | undefined): string | undefined {
  const current = git(worktree, ['branch', '--show-current']).out;
  if (branch && current === branch) return undefined;
  const owner = current ? ws.tasks.find((t) => t.branch === current) : undefined;
  const why = owner?.status === BLOCKED_STATUS ? 'blocked on questions' : `saved before switching to ${branch ?? base}`;
  const saved = saveWork(worktree, why);
  switchWorktree(repo, worktree, base, branch);
  return saved;
}

/** Run records, newest first. Records from before the flow name the idea `task`. */
async function runRecords(dir: string): Promise<RunRecord[]> {
  const runs = path.join(dir, 'runs');
  const files = (await fs.readdir(runs).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort().reverse();
  const out: RunRecord[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await fs.readFile(path.join(runs, f), 'utf8'));
      out.push({ ...r, idea: r.idea ?? r.task });
    } catch {
      // ignore unreadable records
    }
  }
  return out;
}

/** The latest run on an idea (optionally by one agent). */
async function lastRun(dir: string, idea: string, agent?: string): Promise<RunRecord | undefined> {
  return (await runRecords(dir)).find((r) => r.idea === idea && (!agent || r.agent === agent));
}

/** The session id of the agent's latest run on this idea that has one, to resume or reopen it. */
async function lastSession(dir: string, idea: string, agent: string): Promise<string | undefined> {
  return (await runRecords(dir)).find((r) => r.idea === idea && r.agent === agent && r.sessionId)?.sessionId;
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
  const body = `${summary}\n\nIdea: \`${path.relative(repo, task.file).split(path.sep).join('/')}\` (\`${task.id}\`). Opened by \`mdpm agent run\`.`;
  const pr = gh(['pr', 'create', '--head', branch, '--title', task.title, '--body', body]);
  if (pr.status !== 0) {
    log(`Pushed ${branch}, but "gh pr create" failed (${(pr.stderr || pr.stdout).trim()}). Open the pull request by hand.`);
    return undefined;
  }
  return pr.stdout.trim().split(/\s+/).find((s) => s.startsWith('http'));
}


/** What the person is told when there is nothing for the agent to do. */
function describeIdle(ws: Workspace): string {
  const { skipped } = flowQueue(ws);
  if (!skipped.length) return 'Nothing to do: there are no ideas to plan and no approved plans. Write one with "mdpm idea <title>".';
  return `Nothing the agent can do right now; it waits on you:\n${skipped.map((s) => `  • ${s.task.id}: ${s.reason}`).join('\n')}`;
}

/** Plans or executes ideas: one run, or with `untilIdle` one after another until nothing is left. */
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
  if (!repo) throw new RunnerError(`${ws.root} is not in a git repository. "mdpm agent run" builds each idea on its own branch, so it needs one: run "git init" and make a first commit.`);
  if (!git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) throw new RunnerError('The repository has no commits yet, so there is nothing to branch from. Make a first commit, then try again.');

  const dir = await stateDir(repo);
  const running = await readActive(dir);
  if (running.length && !opts.dryRun) throw new RunnerError(busyMessage(running[0]));
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

  const bin = opts.cli && !opts.dryRun ? await writeShims(dir, opts.cli) : undefined;
  const runs = new Map<string, number>();
  const records: RunRecord[] = [];

  for (let n = 0; ; n++) {
    if (n > 0) ws = await loadWorkspace(ws.root);
    let pick: FlowPick | undefined;
    if (opts.idea) {
      const task = findTask(ws, opts.idea);
      if (!task) throw new RunnerError(`No idea with id or path "${opts.idea}". Run "mdpm list" to see idea ids.`);
      const how = modeFor(ws, task);
      if ('reason' in how) throw new RunnerError(`The agent can't work on "${task.id}" now: ${how.reason}`);
      pick = { task, mode: how.mode, resume: how.resume, plan: planCheck(task.body) };
    } else {
      const exclude = new Set([...runs].filter(([, k]) => k >= MAX_RUNS_PER_IDEA).map(([id]) => id));
      pick = flowQueue(ws, { exclude }).picks[0];
      if (!pick) return { records, stopped: n === 0 ? describeIdle(ws) : `Nothing left to do. ${describeIdle(ws).replace(/^Nothing[^:]*: ?/, '')}`.trim() };
    }
    runs.set(pick.task.id, (runs.get(pick.task.id) ?? 0) + 1);

    const record = await runOne(ws, pick, { opts, def, agentName, repo, dir, bin, log });
    if (!record) return { records, stopped: 'Dry run: nothing was changed.' };
    records.push(record);
    if (record.limited) return { records, stopped: `${agentName} hit its usage limit${record.resetsAt ? `; it resets ${new Date(record.resetsAt).toLocaleString()}` : ''}.` };
    if (!opts.untilIdle || opts.idea) return { records, stopped: describeAfter(record) };
    if (record.outcome === 'no handoff' || record.outcome === 'no plan') {
      return { records, stopped: `Stopped: the run on "${record.idea}" ended without writing anything back. Read its log (mdpm show ${record.idea}) before running again.` };
    }
  }
}

/** One line on what a single run left behind. */
function describeAfter(r: RunRecord): string {
  const next: Record<string, string> = {
    planned: `"${r.idea}" has a plan waiting for your approval (mdpm show ${r.idea}, then mdpm approve ${r.idea}).`,
    'handed off': `"${r.idea}" is ready for your review${r.pr ? ` (${r.pr})` : ` on ${r.branch}`}.`,
    blocked: `"${r.idea}" is blocked on a question for you (mdpm show ${r.idea}).`,
    'max turns': `"${r.idea}" is still executing; the next run resumes it.`,
  };
  return next[r.outcome] ?? `Done: "${r.idea}" is ${r.status}.`;
}

interface RunContext {
  opts: RunOptions;
  def: AgentDefinition;
  agentName: string;
  repo: string;
  dir: string;
  bin?: string;
  log: (m: string) => void;
}

/** Runs the agent once on `pick` and records what happened. Undefined for a dry run. */
async function runOne(ws: Workspace, pick: FlowPick, c: RunContext): Promise<RunRecord | undefined> {
  const { task, mode, resume } = pick;
  const { opts, def, agentName, repo, dir, log } = c;
  const id = runId();
  const base = defaultBranch(repo);
  const branch = mode === 'execute' ? task.branch ?? ideaBranch(task) : undefined;
  const worktree = path.join(dir, AGENT_WORKTREE);
  const settings = task.home.agent;
  const sessionId = resume && def.resume ? await lastSession(dir, task.id, agentName) : undefined;
  const prompt = buildPrompt({ agent: agentName, mode, resume, taskId: task.id, taskFile: task.file, taskText: await fs.readFile(task.file, 'utf8'), root: ws.root, worktree, branch: branch ?? base });
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

  log(`▶ ${task.id}: ${mode === 'plan' ? `planning, reading ${base}` : `${resume ? 'resuming' : 'executing'} on ${branch}`} with ${agentName}`);
  if (opts.dryRun) {
    const shown = args.map((a) => (a === prompt ? '<prompt>' : /\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
    log(`  worktree: ${worktree}\n  command:  ${shown}${def.stdin ? ' < <prompt>' : ''}\n\n${prompt}`);
    return undefined;
  }

  const start: WriteBack = mode === 'execute' ? planStart(ws, task, agentName, id) : { changes: {}, log: `started planning (run ${id})`, by: agentName };
  const errors = previewTaskChange(ws, task, start.changes).filter((i) => i.level === 'error');
  if (errors.length) throw new RunnerError(`Starting "${task.id}" would make it invalid, so it was not run:\n${errors.map((i) => `  • ${i.message}`).join('\n')}`);

  const started = new Date();
  let result: AgentResult;
  const live = await markActive(dir, { task: task.id, agent: agentName, mode, run: id });
  try {
    ensureAgentWorktree(repo, worktree, base);
    const saved = prepareWorktree(ws, repo, worktree, base, branch);
    if (saved) log(`  ${saved}`);
    await writeBack(task.file, start);
    await fs.writeFile(promptFile, prompt);
    const env: NodeJS.ProcessEnv = { ...process.env, MDPM_AGENT: agentName, MDPM_TASK: task.id, MDPM_ROOT: ws.root, MDPM_RUN: id };
    delete env.ELECTRON_RUN_AS_NODE; // set when launched from VS Code; the shims set it again for mdpm only
    if (c.bin) {
      const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      env[key] = `${c.bin}${path.delimiter}${env[key] ?? ''}`;
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
    if (e instanceof RunnerError) throw e;
    await writeBack(task.file, { changes: {}, log: `run ${id} failed to start: ${(e as Error).message}`, by: 'mdpm' });
    throw e;
  } finally {
    live.stop();
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
    idea: task.id,
    mode,
    resume: resume || undefined,
    started: started.toISOString(),
    ended: ended.toISOString(),
    durationMs: ended.getTime() - started.getTime(),
    exitCode: result.exitCode,
    status: after.status,
    branch: branch ?? base,
    sessionId: parsed.sessionId,
    costUsd: parsed.costUsd,
    outcome: '',
  };
  const note = (text: string) => writeBack(after.file, { changes: {}, log: text, by: 'mdpm' });

  if (lim.limited) {
    record.limited = true;
    record.resetsAt = lim.resetsAt?.toISOString() ?? lim.text;
    record.outcome = 'usage limit';
    await note(`run ${id} stopped: ${agentName} hit its usage limit${lim.text ? ` (resets ${lim.text})` : ''}. It stays ${after.status} and ${mode === 'plan' ? 'is planned again' : 'resumes'} on a later run.`);
    if (lim.resetsAt) await fs.writeFile(path.join(dir, 'limit.json'), JSON.stringify({ agent: agentName, until: lim.resetsAt.toISOString(), run: id }, null, 2));
  } else if (mode === 'plan') {
    const stashed = saveWork(worktree, `left by the plan run ${id}`);
    if (stashed) await note(`run ${id}: the plan run changed files, which it shouldn't; ${stashed}`);
    if (after.status === 'idea' && planCheck(after.body).complete) {
      // The agent wrote a plan but didn't propose it; the person reviews it either way.
      await writeBack(after.file, { ...planPropose(after, 'mdpm'), log: `run ${id}: the plan was written but not proposed; it now waits for your approval` });
      record.outcome = 'planned';
    } else if (after.status === 'idea') {
      await writeBack(after.file, { ...planBlock(after, 'mdpm', [NO_PLAN_QUESTION]), log: `run ${id}: ${agentName} ${exitWhy(parsed, result, values.maxTurns)} without writing a plan` });
      record.outcome = 'no plan';
    } else {
      record.outcome = after.status === 'plan' ? 'planned' : after.status === BLOCKED_STATUS ? 'blocked' : after.status;
    }
  } else if (after.status === 'review') {
    const committed = saveWork(worktree, 'uncommitted changes left at handoff');
    const ahead = Number(git(repo, ['rev-list', '--count', `${base}..${branch}`]).out) || 0;
    const summary = logEntries(after.body).filter((e) => e.by === agentName).at(-1)?.text.replace(/^handed off for review:\s*/i, '') ?? `Work on ${task.title}`;
    const changes: Record<string, unknown> = {};
    if (ahead) {
      const pr = pushAndOpenPr(repo, worktree, branch!, after, summary, log);
      if (pr && pr !== after.pr) {
        changes.pr = pr;
        record.pr = pr;
      }
    }
    // Free the branch, so the person can check it out to review it.
    git(worktree, ['checkout', '--quiet', '--detach']);
    const text = ahead ? (record.pr ? `opened ${record.pr}` : `work is on branch ${branch}`) : 'handed off with no commits on its branch';
    await writeBack(after.file, { changes, log: `run ${id}: ${text}${committed ? `; ${committed}` : ''}`, by: 'mdpm' });
    record.outcome = 'handed off';
  } else if (after.status === 'executing') {
    await note(`run ${id}: ${agentName} ${exitWhy(parsed, result, values.maxTurns)}. Left executing, so the next run resumes it.`);
    record.outcome = parsed.maxTurns ? 'max turns' : 'no handoff';
  } else {
    record.outcome = after.status === BLOCKED_STATUS ? 'blocked' : after.status;
  }

  record.status = (findTask(await loadWorkspace(ws.root), task.file) ?? after).status;
  await fs.writeFile(path.join(dir, 'runs', `${id}.json`), JSON.stringify(record, null, 2));
  log(`■ ${task.id}: ${record.outcome} (status ${record.status}, ${Math.round(record.durationMs / 1000)}s${record.costUsd !== undefined ? `, $${record.costUsd.toFixed(2)}` : ''}${record.pr ? `, ${record.pr}` : ''})`);
  return record;
}

/** Why an agent stopped without finishing, in words. */
function exitWhy(parsed: { maxTurns?: boolean }, result: AgentResult, maxTurns: string): string {
  if (parsed.maxTurns) return `reached the turn limit (${maxTurns})`;
  const tail = (result.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
  return `exited (code ${result.exitCode ?? 'none'}) without finishing${tail ? `: ${tail}` : ''}`;
}

export interface ContinueOptions {
  /** Workspace root (the main checkout). */
  root: string;
  /** Idea id or path. */
  task: string;
  /** Agent to talk to; default: the agent of the idea's latest run, else the default agent. */
  agent?: string;
  /** Start a new conversation even if an earlier one can be reopened. */
  fresh?: boolean;
  /** Plan only: don't touch the worktree or write the `mdpm` shims. */
  dryRun?: boolean;
  cli?: { node: string; script: string };
}

export interface ContinuePlan {
  agent: string;
  task: Task;
  worktree: string;
  /** The idea's branch, or the default branch (detached) for an idea that hasn't been executed yet. */
  branch: string;
  /** Program and arguments to run, with no placeholders left. */
  command: string[];
  env: NodeJS.ProcessEnv;
  /** True when the agent's last run on the idea is reopened; false for a new conversation that starts from the idea. */
  reopened: boolean;
  /** The runner state folder (`.mdpm`), where the session is marked as active. */
  stateDir: string;
  /** The agent worktree didn't exist yet and was created. */
  recreated: boolean;
}

/**
 * Prepares an interactive session with an agent on an idea: puts the agent worktree on the idea's
 * branch (saving whatever was in progress there first), and builds the command that reopens the
 * agent's last run on the idea, or starts a new conversation that begins with the idea. Idea state
 * and the person's directions stay theirs: `MDPM_AGENT` is not set.
 */
export async function planContinue(opts: ContinueOptions): Promise<ContinuePlan> {
  const ws = await loadWorkspace(opts.root);
  const task = findTask(ws, opts.task);
  if (!task) throw new RunnerError(`No idea with id or path "${opts.task}". Run "mdpm list" to see idea ids.`);
  const defs = agentDefinitions(ws);
  const repo = gitRoot(ws.root);
  if (!repo) throw new RunnerError(`${ws.root} is not in a git repository, so there is no branch or worktree to continue in. Run "git init" and make a first commit.`);
  const dir = await stateDir(repo);

  const running = await readActive(dir);
  if (running.length) throw new RunnerError(busyMessage(running[0]));
  const previous = await lastRun(dir, task.id, opts.agent);
  const agentName = opts.agent ?? previous?.agent ?? defs.default;
  const def = defs.agents[agentName];
  if (!def) throw new RunnerError(`No agent "${agentName}". Known agents: ${Object.keys(defs.agents).join(', ')}. Define it under "agents:" in the root .proj.`);

  // Every idea shares the agent worktree, so the conversation is found by the session id of the idea's last run.
  const sessionId = !opts.fresh && def.continueInteractive ? await lastSession(dir, task.id, agentName) : undefined;
  const reopened = !!sessionId;
  const template = reopened ? def.continueInteractive : def.interactive;
  if (!template) {
    throw new RunnerError(
      `Agent "${agentName}" has no "interactive" command, so it can't start a conversation. Add one under agents.${agentName} in the root .proj, e.g.\n  agents:\n    ${agentName}:\n      interactive: [${agentName}, "{prompt}"]`,
    );
  }

  const base = defaultBranch(repo);
  const branch = task.branch;
  const worktree = path.join(dir, AGENT_WORKTREE);
  const recreated = !existsSync(path.join(worktree, '.git'));
  if (!opts.dryRun) {
    ensureAgentWorktree(repo, worktree, base);
    prepareWorktree(ws, repo, worktree, base, branch);
  }

  const prompt = buildContinuePrompt({ agent: agentName, taskId: task.id, taskFile: task.file, taskText: await fs.readFile(task.file, 'utf8'), root: ws.root, worktree, branch: branch ?? `${base} (detached)` });
  const command = expandArgs(template, {
    prompt,
    taskFile: task.file,
    taskId: task.id,
    worktree,
    root: ws.root,
    maxTurns: String(task.home.agent.maxTurns),
    allowedTools: task.home.agent.allowedTools,
    sessionId: sessionId ?? '',
  });

  const env: NodeJS.ProcessEnv = { ...process.env, MDPM_TASK: task.id, MDPM_ROOT: ws.root };
  delete env.MDPM_AGENT; // the person is directing, so the agent-only restrictions don't apply
  delete env.ELECTRON_RUN_AS_NODE; // set when launched from VS Code; the shims set it again for mdpm only
  if (opts.cli && !opts.dryRun) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[key] = `${await writeShims(dir, opts.cli)}${path.delimiter}${env[key] ?? ''}`;
  }
  return { agent: agentName, task, worktree, branch: branch ?? base, command, env, reopened, stateDir: dir, recreated };
}

/** Runs a planned interactive session attached to this terminal and resolves with the agent's exit code. */
export async function runInteractive(plan: ContinuePlan): Promise<number | null> {
  const live = await markActive(plan.stateDir, { task: plan.task.id, agent: plan.agent, mode: 'chat', run: `chat-${process.pid}` });
  try {
    return await spawnInteractive(plan);
  } finally {
    live.stop();
  }
}

function spawnInteractive(plan: ContinuePlan): Promise<number | null> {
  return new Promise((resolve) => {
    const r = resolveCommand(plan.command[0], plan.command.slice(1), plan.env);
    const child = spawn(r.file, r.args, { cwd: plan.worktree, env: plan.env, stdio: 'inherit', windowsVerbatimArguments: r.verbatim });
    child.on('error', (e) => {
      const hint = (e as NodeJS.ErrnoException).code === 'ENOENT' ? ` "${plan.command[0]}" was not found on PATH. Install it, or point the agent's "interactive" command in the root .proj at the program.` : '';
      console.error(`${e.message}.${hint}`);
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
}
