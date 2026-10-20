import * as path from 'path';
import { Task, TaskLocation, TaskMeta } from './types';

/** Turns parsed front matter into a Task. Lenient: validation reports bad values separately. */
export function buildTask(file: string, meta: TaskMeta, body: string, locations: TaskLocation[], lines: Record<string, number> = {}): Task {
  const home = locations[0].project;
  const base = path.basename(file, path.extname(file));
  return {
    id: str(meta.id) ?? base,
    title: str(meta.title) ?? firstHeading(body) ?? base,
    status: str(meta.status) ?? 'idea',
    author: str(meta.author),
    created: date(meta.created),
    priority: typeof meta.priority === 'number' ? meta.priority : str(meta.priority),
    tags: stringList(meta.tags),
    approved: date(meta.approved),
    blockedFrom: str(meta.blocked_from),
    branch: str(meta.branch),
    pr: str(meta.pr),
    completed: date(meta.completed),
    file,
    locations,
    home,
    meta,
    body,
    lines,
  };
}

function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return m?.[1];
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function date(v: unknown): string | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return str(v);
}

export function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter((s): s is string => !!s);
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
