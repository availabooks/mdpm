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
const PLAN = '\n## Acceptance criteria\n\n- [ ] it works\n';

async function issuesFor(rel: string) {
  const ws = await loadWorkspace(root);
  return ws.issues.filter((i) => i.file === path.join(root, rel));
}

beforeEach(async () => {
  root = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), 'mdpm-validate-')));
  await write('.proj', 'name: Root\n');
});

describe('project settings', () => {
  it('accepts a well-formed .proj', async () => {
    await write('.proj', 'name: Root\ntaskExtension: .task\nignore: [assets]\nagent:\n  maxTurns: 20\n');
    expect(await issuesFor('.proj')).toEqual([]);
  });

  it('reports wrong types and values with line numbers', async () => {
    await write('.proj', 'name: [a, b]\ntaskExtension: txt\nignore: [src/assets, "*.tmp"]\n');
    const issues = await issuesFor('.proj');
    expect(issues.map((i) => [i.code, i.field, i.line])).toEqual([
      ['proj/field-type', 'name', 1],
      ['proj/field-value', 'taskExtension', 2],
      ['proj/field-value', 'ignore', 3],
    ]);
  });

  it('flags settings from the task-based workflow, saying how to migrate', async () => {
    await write('.proj', 'name: Root\nstatuses: [todo, done]\nrequired: [owner]\nrequiredByStatus:\n  done: [end]\nagent:\n  unassigned: true\n  modes: [refine]\n');
    const issues = await issuesFor('.proj');
    expect(issues.map((i) => [i.level, i.code, i.field])).toEqual([
      ['warning', 'proj/obsolete-field', 'statuses'],
      ['warning', 'proj/obsolete-field', 'required'],
      ['warning', 'proj/obsolete-field', 'requiredByStatus'],
      ['warning', 'proj/obsolete-field', 'agent'],
      ['warning', 'proj/obsolete-field', 'agent'],
    ]);
    expect(issues[0].message).toContain('mdpm migrate --write');
  });

  it('flags likely typos in setting names but allows custom settings', async () => {
    await write('.proj', 'name: Root\nignor: [x]\nteam: platform\n');
    const issues = await issuesFor('.proj');
    expect(issues.map((i) => [i.level, i.code, i.field])).toEqual([['error', 'proj/unknown-field', 'ignor']]);
    expect(issues[0].message).toContain('Did you mean "ignore"?');
  });

  it('reports invalid YAML and non-mapping content', async () => {
    await write('a/.proj', 'name: [unclosed\n');
    await write('b/.proj', '- just\n- a list\n');
    expect(codes(await issuesFor('a/.proj'))).toEqual(['proj/yaml-invalid']);
    expect(codes(await issuesFor('b/.proj'))).toEqual(['proj/yaml-invalid']);
  });
});

describe('ideas', () => {
  it('accepts a well-formed idea', async () => {
    await write('ok.md', task('title: OK\nstatus: plan\napproved: 2026-10-20\npriority: 1\ntags: [a]\nestimate: 3d', PLAN));
    expect(await issuesFor('ok.md')).toEqual([]);
  });

  it('rejects statuses outside the flow, with a hint and the line', async () => {
    await write('t.md', task('title: T\nstatus: Done'));
    const [issue] = await issuesFor('t.md');
    expect(issue).toMatchObject({ level: 'error', code: 'task/status-unknown', field: 'status', line: 3 });
    expect(issue.message).toContain('Did you mean "done"?');
  });

  it('points old task statuses at mdpm migrate', async () => {
    await write('t.md', task('status: in-progress'));
    const [issue] = await issuesFor('t.md');
    expect(issue.code).toBe('task/status-unknown');
    expect(issue.message).toMatch(/task-based workflow; in the flow it is "executing".*mdpm migrate --write/);
  });

  it('flags fields from the task-based workflow', async () => {
    await write('t.md', task('status: idea\nowner: claude\nstart: 2026-10-01\ndepends_on: [x]'));
    expect((await issuesFor('t.md')).map((i) => [i.level, i.code, i.field])).toEqual([
      ['warning', 'task/obsolete-field', 'owner'],
      ['warning', 'task/obsolete-field', 'start'],
      ['warning', 'task/obsolete-field', 'depends_on'],
    ]);
  });

  it('rejects malformed and impossible dates', async () => {
    await write('a.md', task('status: done\ncreated: 2026-02-30\ncompleted: Oct 3'));
    expect(codes(await issuesFor('a.md'))).toEqual(['task/date-invalid', 'task/date-invalid']);
  });

  it('rejects wrong field types', async () => {
    await write('t.md', task('status: [idea]\nauthor: {name: eli}\ntags: {a: 1}'));
    expect((await issuesFor('t.md')).map((i) => i.field)).toEqual(['status', 'author', 'tags']);
  });

  it('warns about likely typos in field names', async () => {
    await write('t.md', task('stauts: done\nPriority: 1\npriority: 2\ndue: 2026-01-01'));
    const issues = await issuesFor('t.md');
    expect(issues.map((i) => [i.level, i.code, i.field])).toEqual([
      ['error', 'task/unknown-field', 'stauts'], // status is missing, so its value is lost
      ['warning', 'task/unknown-field', 'Priority'], // priority is also set, so nothing is lost
    ]);
    expect(issues[0].message).toContain('shows as "idea"');
  });

  it('a blocked idea needs a question and somewhere to return to', async () => {
    await write('a.md', task('status: blocked'));
    await write('b.md', task('status: blocked\nblocked_from: review', '## Questions\n\n- [ ] q?\n'));
    await write('c.md', task('status: blocked\nblocked_from: executing', '## Questions\n\n- [ ] q?\n'));
    await write('d.md', task('status: plan\nblocked_from: idea'));
    expect(codes(await issuesFor('a.md'))).toEqual(['task/blocked-from-missing', 'task/blocked-without-question']);
    expect(codes(await issuesFor('b.md'))).toEqual(['task/blocked-from-invalid']);
    expect(await issuesFor('c.md')).toEqual([]);
    expect(codes(await issuesFor('d.md'))).toEqual(['task/blocked-from-stale']);
  });

  it('checks approvals against the status and the plan', async () => {
    await write('a.md', task('status: idea\napproved: 2026-10-20'));
    await write('b.md', task('status: plan\napproved: 2026-10-20'));
    expect(codes(await issuesFor('a.md'))).toEqual(['task/approved-idea']);
    expect(codes(await issuesFor('b.md'))).toEqual(['task/plan-incomplete']);
  });

  it('allows only one idea in the execution slot, counting one blocked while executing', async () => {
    await write('a.md', task('status: executing'));
    await write('b.md', task('status: blocked\nblocked_from: executing', '## Questions\n\n- [ ] q?\n'));
    await write('c.md', task('status: blocked\nblocked_from: plan', '## Questions\n\n- [ ] q?\n'));
    const a = await issuesFor('a.md');
    expect(codes(a)).toEqual(['task/slot-taken']);
    expect(a[0].message).toContain('"b"');
    expect(codes(await issuesFor('b.md'))).toEqual(['task/slot-taken']);
    expect(await issuesFor('c.md')).toEqual([]);
  });

  it('flags section names from the task-based workflow', async () => {
    await write('t.md', task('status: idea', '\n## Description\n\nx\n\n## Agent log\n\n- 2026-10-19 eli — note\n'));
    expect(codes(await issuesFor('t.md'))).toEqual(['task/obsolete-section', 'task/obsolete-section']);
  });

  it('reports duplicate ids and invalid front matter YAML with its line', async () => {
    await write('a/t.md', task('status: idea'));
    await write('b/t.md', task('status: idea'));
    await write('y.md', task('title: ok\nstatus: [idea'));
    expect(codes(await issuesFor('a/t.md'))).toEqual(['task/duplicate-id']);
    const [issue] = await issuesFor('y.md');
    expect(issue.code).toBe('task/yaml-invalid');
    expect(issue.line).toBeGreaterThanOrEqual(3);
  });
});

describe('previewing writes', () => {
  beforeEach(async () => {
    await write('a.md', task('status: idea\ncreated: not a date'));
    await write('b.md', task('status: executing'));
  });

  it('only reports new problems, so an old mistake never blocks a change', async () => {
    const ws = await loadWorkspace(root);
    const a = findTask(ws, 'a')!;
    expect(previewTaskChange(ws, a, { priority: 1 })).toEqual([]);
    expect(previewTaskChange(ws, a, { status: 'shipped' }).map((i) => i.code)).toEqual(['task/status-unknown']);
  });

  it('catches a second idea taking the execution slot', async () => {
    const ws = await loadWorkspace(root);
    expect(previewTaskChange(ws, findTask(ws, 'a')!, { status: 'executing' }).map((i) => i.code)).toEqual(['task/slot-taken']);
  });

  it('validates a new idea before it is written', async () => {
    const ws = await loadWorkspace(root);
    const project = findProject(ws, '.')!;
    expect(previewNewTask(ws, project, path.join(root, 'c.md'), { title: 'C', status: 'idea' })).toEqual([]);
    expect(previewNewTask(ws, project, path.join(root, 'other', 'b.md'), { title: 'B', status: 'todo' }).map((i) => i.code).sort()).toEqual(['task/duplicate-id', 'task/status-unknown']);
  });
});
