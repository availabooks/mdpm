import { promises as fs, mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Issue, findProject, findTask, loadWorkspace, previewNewTask, previewTaskChange } from '../src';

let root: string;

async function write(rel: string, text: string) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

const task = (fields: string, body = '') => `---\n${fields}\n---\n${body}`;
const codes = (issues: Issue[]) => issues.map((i) => i.code).sort();

async function issuesFor(rel: string) {
  const ws = await loadWorkspace(root);
  return ws.issues.filter((i) => i.file === path.join(root, rel));
}

beforeEach(async () => {
  root = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), 'mdpm-validate-')));
  await write('.proj', 'name: Root\nstatuses: [todo, doing, done]\n');
});

describe('project settings', () => {
  it('accepts a well-formed .proj', async () => {
    await write('.proj', 'name: Root\nstatuses: [todo, doing, done]\ntaskExtension: .task\nignore: [assets]\nrequired: [owner]\nrequiredByStatus:\n  doing: [start]\n');
    expect(await issuesFor('.proj')).toEqual([]);
  });

  it('reports wrong types and values with line numbers', async () => {
    await write('.proj', 'name: [a, b]\nstatuses: todo\ntaskExtension: txt\nignore: [src/assets, "*.tmp"]\n');
    const issues = await issuesFor('.proj');
    expect(issues.map((i) => [i.code, i.field, i.line])).toEqual([
      ['proj/field-type', 'name', 1],
      ['proj/field-type', 'statuses', 2],
      ['proj/field-value', 'taskExtension', 3],
      ['proj/field-value', 'ignore', 4],
    ]);
  });

  it('reports empty and duplicate statuses', async () => {
    await write('a/.proj', 'statuses: []\n');
    await write('b/.proj', 'statuses: [todo, done, todo]\n');
    expect(codes(await issuesFor('a/.proj'))).toEqual(['proj/statuses-empty']);
    expect(codes(await issuesFor('b/.proj'))).toEqual(['proj/statuses-duplicate']);
  });

  it('checks requiredByStatus against the statuses', async () => {
    await write('.proj', 'statuses: [todo, done]\nrequiredByStatus:\n  in-progress: [owner]\n  done: [ownr]\n');
    const issues = await issuesFor('.proj');
    expect(codes(issues)).toEqual(['proj/required-unknown-status', 'proj/unknown-field']);
    expect(issues.find((i) => i.code === 'proj/unknown-field')!.message).toContain('Did you mean "owner"?');
  });

  it('flags likely typos in setting names but allows custom settings', async () => {
    await write('.proj', 'name: Root\nstatus: [todo]\nteam: platform\n');
    const issues = await issuesFor('.proj');
    expect(issues.map((i) => [i.level, i.code, i.field])).toEqual([['error', 'proj/unknown-field', 'status']]);
    expect(issues[0].message).toContain('Did you mean "statuses"?');
  });

  it('reports invalid YAML and non-mapping content', async () => {
    await write('a/.proj', 'name: [unclosed\n');
    await write('b/.proj', '- just\n- a list\n');
    expect(codes(await issuesFor('a/.proj'))).toEqual(['proj/yaml-invalid']);
    expect(codes(await issuesFor('b/.proj'))).toEqual(['proj/yaml-invalid']);
  });
});

describe('task settings', () => {
  it('accepts a well-formed task', async () => {
    await write('ok.md', task('title: OK\nstatus: doing\nowner: eli\nstart: 2026-02-27\nend: 2026-03-02\npriority: 1\ntags: [a]\nestimate: 3d'));
    expect(await issuesFor('ok.md')).toEqual([]);
  });

  it('rejects unknown statuses, with a hint and the line', async () => {
    await write('t.md', task('title: T\nstatus: Done'));
    const [issue] = await issuesFor('t.md');
    expect(issue).toMatchObject({ level: 'error', code: 'task/status-unknown', field: 'status', line: 3 });
    expect(issue.message).toContain('Did you mean "done"?');
  });

  it('rejects malformed and impossible dates, and end before start', async () => {
    await write('a.md', task('start: 2026-02-30\nend: Oct 3'));
    await write('b.md', task('start: 2026-03-05\nend: 2026-03-01'));
    expect(codes(await issuesFor('a.md'))).toEqual(['task/date-invalid', 'task/date-invalid']);
    expect(codes(await issuesFor('b.md'))).toEqual(['task/date-order']);
  });

  it('rejects wrong field types', async () => {
    await write('t.md', task('status: [todo]\nowner: {name: eli}\ntags: {a: 1}'));
    expect((await issuesFor('t.md')).map((i) => i.field)).toEqual(['status', 'owner', 'tags']);
  });

  it('warns about likely typos in field names', async () => {
    await write('t.md', task('stauts: done\nOwner: eli\nowner: sam\ndue: 2026-01-01'));
    const issues = await issuesFor('t.md');
    expect(issues.map((i) => [i.level, i.code, i.field])).toEqual([
      ['error', 'task/unknown-field', 'stauts'], // status is missing, so its value is lost
      ['warning', 'task/unknown-field', 'Owner'], // owner is also set, so nothing is lost
    ]);
    expect(issues[0].message).toContain('shows as "todo"');
  });

  it('enforces required and requiredByStatus rules, inherited by sub projects', async () => {
    await write('.proj', 'statuses: [todo, doing, done]\nrequired: [title]\nrequiredByStatus:\n  doing: [owner, start]\n');
    await write('sub/.proj', 'name: Sub\n');
    await write('sub/t.md', task('title: T\nstatus: doing\nowner: eli'));
    await write('sub/u.md', task('status: todo'));
    const t = await issuesFor('sub/t.md');
    expect(t.map((i) => [i.code, i.field])).toEqual([['task/required-missing', 'start']]);
    expect(t[0].message).toContain('rule "requiredByStatus" in .proj');
    expect((await issuesFor('sub/u.md')).map((i) => i.field)).toEqual(['title']);
  });

  it('checks dependencies: unknown, self, cycles, and done-before-dependency', async () => {
    await write('a.md', task('status: todo\ndepends_on: [b]'));
    await write('b.md', task('status: todo\ndepends_on: [a, b]'));
    await write('c.md', task('status: done\ndepends_on: [a, nope]'));
    expect(codes(await issuesFor('a.md'))).toEqual(['task/dependency-cycle']);
    expect(codes(await issuesFor('b.md'))).toEqual(['task/dependency-cycle', 'task/dependency-self']);
    expect(codes(await issuesFor('c.md'))).toEqual(['task/dependency-open', 'task/dependency-unknown']);
  });

  it('reports invalid front matter YAML with its line', async () => {
    await write('t.md', task('title: ok\nstatus: [todo'));
    const [issue] = await issuesFor('t.md');
    expect(issue.code).toBe('task/yaml-invalid');
    expect(issue.line).toBeGreaterThanOrEqual(3);
  });
});

describe('previewing writes', () => {
  beforeEach(async () => {
    await write('.proj', 'statuses: [todo, doing, done]\nrequiredByStatus:\n  doing: [owner]\n');
    await write('a.md', task('status: todo\nstart: not a date'));
    await write('b.md', task('status: todo\nowner: eli'));
  });

  it('blocks a status change that breaks a rule, and only reports new problems', async () => {
    const ws = await loadWorkspace(root);
    const a = findTask(ws, 'a')!;
    expect(previewTaskChange(ws, a, { status: 'doing' }).map((i) => i.code)).toEqual(['task/required-missing']);
    expect(previewTaskChange(ws, a, { status: 'doing', owner: 'claude' })).toEqual([]);
    expect(previewTaskChange(ws, a, { status: 'shipped' }).map((i) => i.code)).toEqual(['task/status-unknown']);
  });

  it('catches dependency cycles introduced by a change', async () => {
    await write('b.md', task('status: todo\ndepends_on: [a]'));
    const ws = await loadWorkspace(root);
    expect(previewTaskChange(ws, findTask(ws, 'a')!, { depends_on: ['b'] }).map((i) => i.code)).toEqual(['task/dependency-cycle']);
  });

  it('validates a new task before it is written', async () => {
    const ws = await loadWorkspace(root);
    const project = findProject(ws, '.')!;
    expect(previewNewTask(ws, project, path.join(root, 'c.md'), { title: 'C', status: 'todo' })).toEqual([]);
    expect(previewNewTask(ws, project, path.join(root, 'other', 'b.md'), { title: 'B', status: 'doing' }).map((i) => i.code).sort()).toEqual([
      'task/duplicate-id',
      'task/required-missing',
    ]);
  });
});
