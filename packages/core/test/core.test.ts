import { promises as fs, mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createProject,
  createTask,
  findProject,
  findTask,
  linkTask,
  loadWorkspace,
  parseFrontMatter,
  splitFrontMatter,
  tasksInProject,
  unlinkTask,
  updateFrontMatter,
  updateTask,
} from '../src';

describe('front matter', () => {
  it('splits and parses', () => {
    const p = parseFrontMatter('---\ntitle: Hello\nstatus: todo\n---\n# Body\n');
    expect(p?.data).toEqual({ title: 'Hello', status: 'todo' });
    expect(p?.body).toBe('# Body\n');
  });

  it('handles CRLF, BOM and empty front matter', () => {
    expect(parseFrontMatter('﻿---\r\nstatus: done\r\n---\r\nx')?.data).toEqual({ status: 'done' });
    expect(splitFrontMatter('---\n---\nbody')).toEqual({ yaml: '', body: 'body' });
    expect(splitFrontMatter('no front matter')).toBeNull();
    expect(splitFrontMatter('---\nunterminated: true\n')).toBeNull();
  });

  it('keeps dates as strings', () => {
    expect(parseFrontMatter('---\nstart: 2026-10-19\n---\n')?.data.start).toBe('2026-10-19');
  });

  it('reports YAML errors instead of throwing', () => {
    expect(parseFrontMatter('---\ntitle: [oops\n---\n')?.error).toBeTruthy();
  });

  it('updates in place, preserving comments, order and line endings', () => {
    const src = '---\r\ntitle: A # keep me\r\nstatus: todo\r\nowner: eli\r\n---\r\nbody\r\n';
    const out = updateFrontMatter(src, { status: 'done', owner: null, end: '2026-11-01' });
    expect(out).toBe('---\r\ntitle: A # keep me\r\nstatus: done\r\nend: 2026-11-01\r\n---\r\nbody\r\n');
  });

  it('adds front matter to a file without one', () => {
    expect(updateFrontMatter('# Just text\n', { status: 'todo' })).toBe('---\nstatus: todo\n---\n# Just text\n');
  });
});

describe('workspace', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), 'mdpm-')));
    await createProject(root, { name: 'Root', statuses: ['todo', 'doing', 'done'] });
    await createProject(path.join(root, 'web'), { name: 'Web' });
    await createProject(path.join(root, 'api'), { name: 'API', statuses: ['open', 'closed'] });
    await fs.mkdir(path.join(root, 'web', 'notes'));
    await fs.writeFile(path.join(root, 'web', 'README.md'), '# Not a task\n');
    await fs.writeFile(
      path.join(root, 'web', 'login.md'),
      '---\ntitle: Login page\nstatus: doing\nowner: eli\nstart: 2026-10-01\nend: 2026-10-05\ntags: [ui, auth]\n---\n',
    );
    await fs.writeFile(path.join(root, 'web', 'notes', 'nested.task'), '---\nstatus: todo\n---\n# Nested heading title\n');
    await fs.writeFile(path.join(root, 'api', 'auth.md'), '---\nid: AUTH-1\nstatus: open\ndepends_on: [login, ghost]\n---\n');
  });

  it('builds the project tree with inherited statuses', async () => {
    const ws = await loadWorkspace(root);
    expect(ws.projects.map((p) => p.id)).toEqual(['.', 'api', 'web']);
    const web = findProject(ws, 'web')!;
    expect(web.parent?.name).toBe('Root');
    expect(web.statuses).toEqual(['todo', 'doing', 'done']);
    expect(findProject(ws, 'API')!.statuses).toEqual(['open', 'closed']);
  });

  it('finds projects by id, name or folder name', async () => {
    await createProject(path.join(root, 'web', 'agents'), { name: 'Agent interface' });
    const ws = await loadWorkspace(root);
    expect(findProject(ws, 'web/agents')?.name).toBe('Agent interface');
    expect(findProject(ws, 'agent interface')?.name).toBe('Agent interface');
    expect(findProject(ws, 'agents')?.name).toBe('Agent interface');
    expect(findProject(ws, 'nope')).toBeUndefined();
  });

  it('finds tasks, skips plain markdown, includes plain sub folders', async () => {
    const ws = await loadWorkspace(root);
    expect(ws.tasks.map((t) => t.id).sort()).toEqual(['AUTH-1', 'login', 'nested']);
    const nested = findTask(ws, 'nested')!;
    expect(nested.title).toBe('Nested heading title');
    expect(nested.home.name).toBe('Web');
    const login = findTask(ws, 'login')!;
    expect(login).toMatchObject({ owner: 'eli', start: '2026-10-01', end: '2026-10-05', tags: ['ui', 'auth'] });
  });

  it('validates references', async () => {
    const ws = await loadWorkspace(root);
    expect(ws.issues.map((i) => i.message)).toEqual([expect.stringMatching(/^depends_on lists "ghost", but no task has that id. Use/)]);
  });

  it('shares a task between projects via symlink without duplicating it', async () => {
    const ws0 = await loadWorkspace(root);
    const link = await linkTask(findTask(ws0, 'login')!.file, path.join(root, 'api'));
    expect(link.kind).toEqual(process.platform === 'win32' ? expect.any(String) : 'symlink');

    const ws = await loadWorkspace(root);
    const login = findTask(ws, 'login')!;
    expect(ws.tasks.filter((t) => t.id === 'login')).toHaveLength(1);
    expect(login.home.name).toBe('Web');
    expect(login.locations.map((l) => [l.project.name, l.link ?? null])).toEqual([
      ['Web', null],
      ['API', link.kind],
    ]);
    expect(tasksInProject(ws, findProject(ws, 'api')!).map((t) => t.id).sort()).toEqual(['AUTH-1', 'login']);

    await updateTask(login.file, { status: 'done' });
    expect(findTask(await loadWorkspace(root), 'login')!.status).toBe('done');

    await unlinkTask(link.path);
    expect(findTask(await loadWorkspace(root), 'login')!.locations).toHaveLength(1);
  });

  it('treats a git-on-Windows style stub file as a link', async () => {
    await fs.writeFile(path.join(root, 'api', 'login.md'), '../web/login.md');
    const ws = await loadWorkspace(root);
    const login = findTask(ws, 'login')!;
    expect(login.locations.map((l) => l.link ?? null)).toEqual([null, 'stub']);
    await expect(unlinkTask(login.file)).rejects.toThrow(/not a link/);
  });

  it('reports broken symlinks', async () => {
    if (process.platform === 'win32') return;
    await fs.symlink('../web/missing.md', path.join(root, 'api', 'missing.md'));
    const ws = await loadWorkspace(root);
    expect(ws.issues.some((i) => i.message.startsWith('Broken link: points to "../web/missing.md"'))).toBe(true);
  });

  it('creates tasks with unique slugged names', async () => {
    const dir = path.join(root, 'web');
    const a = await createTask(dir, { title: 'Fix the Café menu!', status: 'todo', tags: ['ui'] });
    const b = await createTask(dir, { title: 'Fix the Café menu!' });
    expect(path.basename(a)).toBe('fix-the-cafe-menu.md');
    expect(path.basename(b)).toBe('fix-the-cafe-menu-2.md');
    const task = findTask(await loadWorkspace(root), 'fix-the-cafe-menu')!;
    expect(task).toMatchObject({ title: 'Fix the Café menu!', status: 'todo', tags: ['ui'] });
  });
});
