import { spawnSync } from 'child_process';
import { existsSync, promises as fs, renameSync, unlinkSync, writeFileSync } from 'fs';
import * as path from 'path';

/*
 * Which tasks an agent is working on right now. The runner (and interactive sessions) write a
 * small marker file under `.mdpm/active/` and refresh it every few seconds; the views read the
 * markers. A marker only counts while its process is alive and its heartbeat is recent, so a run
 * that crashed or was killed stops showing as active on its own.
 */

/** What the agent is doing for the person. */
export type ActivityMode = 'refine' | 'implement' | 'resume' | 'chat';

export interface ActiveRun {
  /** Task id. */
  task: string;
  agent: string;
  mode: ActivityMode;
  /** Run id, or the session's id for `chat`. */
  run: string;
  /** Process that is doing the work. */
  pid: number;
  /** ISO time the work started. */
  started: string;
  /** ISO time of the last heartbeat. */
  updated: string;
}

/** How often the marker is refreshed, and how old a heartbeat may be before the run counts as gone. */
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = 60_000;

/** Short phrase for the badge: "refining", "implementing"… */
export function activityVerb(mode: ActivityMode): string {
  return { refine: 'refining', implement: 'implementing', resume: 'resuming work', chat: 'in a chat with you' }[mode];
}

/** `3m`, `45s`, `1h 5m`: how long ago `iso` was. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The folder holding the markers, for a runner state folder (`.mdpm`). */
export function activeDir(stateDir: string): string {
  return path.join(stateDir, 'active');
}

function markerFile(stateDir: string, task: string): string {
  const safe = task.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 100) || 'task';
  return path.join(activeDir(stateDir), `${safe}.json`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, but not ours
  }
}

export interface ActiveHandle {
  /** Removes the marker and stops the heartbeat. Safe to call more than once. */
  stop(): void;
}

/**
 * Marks `task` as being worked on until `stop()` is called, the process exits, or it is killed by a
 * signal (INT/TERM/HUP), and keeps the marker fresh meanwhile.
 */
export async function markActive(stateDir: string, info: Omit<ActiveRun, 'pid' | 'started' | 'updated'>): Promise<ActiveHandle> {
  const file = markerFile(stateDir, info.task);
  const started = new Date().toISOString();
  const write = () => {
    const run: ActiveRun = { ...info, pid: process.pid, started, updated: new Date().toISOString() };
    // Write then rename, so a watcher never reads a half-written file.
    writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  await fs.mkdir(activeDir(stateDir), { recursive: true });
  write();

  const timer = setInterval(() => {
    try {
      write();
    } catch {
      // the folder may be gone (repo moved or cleaned); the marker then simply expires
    }
  }, HEARTBEAT_MS);
  timer.unref();

  let stopped = false;
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const onSignal = (sig: NodeJS.Signals) => {
    stop();
    process.kill(process.pid, sig); // now that our handlers are gone, die the way we would have
  };
  const handlers = signals.map((sig) => [sig, () => onSignal(sig)] as const);
  const onExit = () => stop();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const [sig, h] of handlers) process.off(sig, h);
    process.off('exit', onExit);
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
  for (const [sig, h] of handlers) process.on(sig, h);
  process.on('exit', onExit);
  return { stop };
}

/** Markers that are still alive: process running and heartbeat recent. Oldest first. */
export async function readActive(stateDir: string, now = Date.now()): Promise<ActiveRun[]> {
  const dir = activeDir(stateDir);
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  const out: ActiveRun[] = [];
  for (const name of names) {
    try {
      const run = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as ActiveRun;
      if (typeof run.task !== 'string' || typeof run.pid !== 'number' || !run.updated) continue;
      if (now - Date.parse(run.updated) > STALE_MS || !pidAlive(run.pid)) continue;
      out.push(run);
    } catch {
      // unreadable or mid-write; the next read gets it
    }
  }
  return out.sort((a, b) => a.started.localeCompare(b.started));
}

/** The runner state folder (`.mdpm`) for a workspace root: at the top of its git repository. */
export function stateDirFor(root: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return undefined;
  const dir = path.join(path.resolve(r.stdout.trim()), '.mdpm');
  return existsSync(dir) ? dir : undefined;
}

/** Agents working in the workspace at `root` right now (none if it has never run an agent). */
export async function loadActive(root: string): Promise<ActiveRun[]> {
  const dir = stateDirFor(root);
  return dir ? readActive(dir) : [];
}
