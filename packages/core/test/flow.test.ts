import { promises as fs, mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AgentError,
  acceptanceCriteria,
  agentGuard,
  applyMigration,
  applyWriteBack,
  dropIntent,
  findTask,
  flowQueue,
  flowStage,
  lastEntryIsStart,
  loadWorkspace,
  logEntries,
  modeFor,
  needsPerson,
  openQuestions,
  planAccept,
  planApprove,
  planBlock,
  planHandoff,
  planMigration,
  planMove,
  planPropose,
  planRework,
  planStart,
  planUnblock,
  today,
  writeBack,
} from '../src';

let root: string;

async function write(rel: string, text: string) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

const PLAN = '\n## Acceptance criteria\n\n- [ ] it works\n';
const idea = (fields: string, body = PLAN) => `---\n${fields}\n---\n${body}`;
const QUESTION = '## Questions\n\n- [ ] (claude, 2026-10-20) which?\n';

const load = async (id: string) => {
  const ws = await loadWorkspace(root);
  return { ws, t: findTask(ws, id)! };
};

beforeEach(async () => {
  root = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), 'mdpm-flow-')));
  await write('.proj', 'name: Root\n');
});

describe('stages', () => {
  it('a blocked idea stays in the column it was blocked from', () => {
    expect(flowStage({ status: 'blocked', blockedFrom: 'executing' })).toBe('executing');
    expect(flowStage({ status: 'blocked', blockedFrom: 'plan' })).toBe('plan');
    expect(flowStage({ status: 'blocked' })).toBe('idea');
    expect(flowStage({ status: 'review' })).toBe('review');
    expect(flowStage({ status: 'nonsense' })).toBe('idea');
  });

  it('counts acceptance criteria, ignoring the empty placeholder', () => {
    expect(acceptanceCriteria('- [x] not one\n\n## Acceptance criteria\n\n- [x] a\n* [X] b\n- [ ] c\n- [ ] \n\n## Questions\n\n- [ ] q?\n')).toEqual({ done: 2, total: 3 });
  });

  it('knows what waits on the person', () => {
    expect(needsPerson({ status: 'plan' })).toBe(true);
    expect(needsPerson({ status: 'plan', approved: '2026-10-20' })).toBe(false);
    expect(needsPerson({ status: 'blocked' })).toBe(true);
    expect(needsPerson({ status: 'review' })).toBe(true);
    expect(needsPerson({ status: 'executing' })).toBe(false);
    expect(needsPerson({ status: 'idea' })).toBe(false);
  });
});

describe('mdpm next', () => {
  it('resumes the execution, then the approved plans in order, then plans ideas', async () => {
    await write('a-idea-low.md', idea('status: idea\npriority: 3\ncreated: 2026-10-01', ''));
    await write('b-idea-high.md', idea('status: idea\npriority: 1\ncreated: 2026-10-05', ''));
    await write('c-plan-later.md', idea('status: plan\napproved: 2026-10-10'));
    await write('d-plan-sooner.md', idea('status: plan\napproved: 2026-10-02'));
    await write('e-rework.md', idea('status: plan\napproved: 2026-10-15\nbranch: idea/e-rework'));
    await write('f-waiting.md', idea('status: plan'));
    const { picks, skipped } = flowQueue(await loadWorkspace(root));
    expect(picks.map((p) => [p.task.id, p.mode])).toEqual([
      ['e-rework', 'execute'],
      ['d-plan-sooner', 'execute'],
      ['c-plan-later', 'execute'],
      ['b-idea-high', 'plan'],
      ['a-idea-low', 'plan'],
    ]);
    expect(skipped.find((s) => s.task.id === 'f-waiting')!.reason).toContain('mdpm approve f-waiting');
  });

  it('runs one idea at a time: while the slot is taken, approved plans wait and ideas are still planned', async () => {
    await write('busy.md', idea('status: executing\nbranch: idea/busy'));
    await write('queued.md', idea('status: plan\napproved: 2026-10-02'));
    await write('new.md', idea('status: idea', ''));
    let q = flowQueue(await loadWorkspace(root));
    expect(q.slot?.id).toBe('busy');
    expect(q.picks.map((p) => [p.task.id, p.mode, p.resume])).toEqual([
      ['busy', 'execute', true],
      ['new', 'plan', false],
    ]);
    expect(q.skipped.find((s) => s.task.id === 'queued')!.reason).toMatch(/#1 in the execution queue.*"busy" is executing/);

    // Blocked while executing still holds the slot: nothing else executes until it is answered.
    await write('busy.md', idea('status: blocked\nblocked_from: executing\nbranch: idea/busy', `${PLAN}\n${QUESTION}`));
    q = flowQueue(await loadWorkspace(root));
    expect(q.picks.map((p) => p.task.id)).toEqual(['new']);
    expect(q.skipped.find((s) => s.task.id === 'queued')!.reason).toContain('blocked on your answer');
    expect(q.skipped.find((s) => s.task.id === 'busy')!.reason).toContain('mdpm unblock busy');
  });

  it('skips ideas with validation errors and projects with agents disabled', async () => {
    await write('off/.proj', 'name: Off\nagent:\n  enabled: false\n');
    await write('off/x.md', idea('status: idea', ''));
    await write('bad.md', idea('status: idea\ncreated: 2026-13-01', ''));
    const { picks, skipped } = flowQueue(await loadWorkspace(root));
    expect(picks).toEqual([]);
    expect(Object.fromEntries(skipped.map((s) => [s.task.id, s.reason]))).toMatchObject({ x: expect.stringContaining('agent.enabled: false'), bad: expect.stringContaining('validation errors') });
  });

  it('says how the agent would work on a given idea, or why not', async () => {
    await write('i.md', idea('status: idea', ''));
    await write('p.md', idea('status: plan'));
    await write('a.md', idea('status: plan\napproved: 2026-10-01'));
    await write('r.md', idea('status: review'));
    const ws = await loadWorkspace(root);
    expect(modeFor(ws, findTask(ws, 'i')!)).toEqual({ mode: 'plan', resume: false });
    expect(modeFor(ws, findTask(ws, 'a')!)).toEqual({ mode: 'execute', resume: false });
    expect(modeFor(ws, findTask(ws, 'p')!)).toMatchObject({ reason: expect.stringContaining('mdpm approve p') });
    expect(modeFor(ws, findTask(ws, 'r')!)).toMatchObject({ reason: expect.stringContaining('in review') });
  });
});

describe('flow commands', () => {
  it('walks an idea through the whole flow', async () => {
    await write('x.md', idea('title: X\nstatus: idea', '\n# X\n\n## Idea\n\nExport CSV\n'));
    let { ws, t } = await load('x');
    expect(() => planPropose(t, 'claude')).toThrow(/isn't complete.*Acceptance criteria/);
    expect(() => planApprove(t, 'eli')).toThrow(/no complete plan yet/);

    await fs.appendFile(t.file, PLAN);
    ({ t } = await load('x'));
    await writeBack(t.file, planPropose(t, 'claude', 'CSV via the CLI'));
    ({ ws, t } = await load('x'));
    expect(t).toMatchObject({ status: 'plan', approved: undefined });
    expect(() => planStart(ws, t, 'claude')).toThrow(/Approve it first: mdpm approve x/);

    await writeBack(t.file, planApprove(t, 'eli'));
    ({ ws, t } = await load('x'));
    expect(t.approved).toBe(today());
    expect(() => planApprove(t, 'eli')).toThrow(/already approved/);

    await writeBack(t.file, planStart(ws, t, 'claude', 'r-1'));
    ({ ws, t } = await load('x'));
    expect(t).toMatchObject({ status: 'executing', branch: 'idea/x' });
    expect(lastEntryIsStart(t, 'claude')).toBe(true);
    expect(planStart(ws, t, 'claude', 'r-2').log).toBe('resumed (run r-2)');

    await writeBack(t.file, planBlock(t, 'claude', ['Archived too?', 'Which delimiter?']));
    ({ ws, t } = await load('x'));
    expect(t).toMatchObject({ status: 'blocked', blockedFrom: 'executing' });
    expect(openQuestions(t.body)).toHaveLength(2);
    expect(openQuestions(t.body)[0]).toMatch(/^\(claude, \d{4}-\d{2}-\d{2}\) Archived too\?$/);

    await writeBack(t.file, planUnblock(ws, t, 'eli', 'No; commas'));
    ({ ws, t } = await load('x'));
    expect(t).toMatchObject({ status: 'executing', blockedFrom: undefined });
    expect(openQuestions(t.body)).toEqual([]); // answered
    expect(logEntries(t.body).at(-1)!.text).toBe('answered: No; commas back to executing');

    await writeBack(t.file, planHandoff(t, 'claude', 'CSV export done', { pr: 'https://example.com/pr/1' }));
    ({ t } = await load('x'));
    expect(t).toMatchObject({ status: 'review', pr: 'https://example.com/pr/1' });

    await writeBack(t.file, planRework(t, 'eli', 'add a header row'));
    ({ ws, t } = await load('x'));
    expect(t).toMatchObject({ status: 'plan', approved: today(), branch: 'idea/x' });
    expect(flowQueue(ws).picks[0].task.id).toBe('x'); // first in line again

    await writeBack(t.file, planStart(ws, t, 'claude'));
    ({ t } = await load('x'));
    await writeBack(t.file, planHandoff(t, 'claude', 'header added'));
    ({ t } = await load('x'));
    await writeBack(t.file, planAccept(t, 'eli'));
    ({ t } = await load('x'));
    expect(t).toMatchObject({ status: 'done', completed: today() });
    expect(logEntries(t.body).map((e) => e.text.split(':')[0])).toEqual([
      'planned',
      'approved the plan',
      'started executing on branch idea/x (run r-1)',
      'blocked on 2 questions (see Questions)',
      'answered',
      'handed off for review',
      'sent back for rework',
      'started executing on branch idea/x',
      'handed off for review',
      'accepted',
    ]);
  });

  it('refuses a second idea in the execution slot, naming the one that holds it', async () => {
    await write('busy.md', idea('status: blocked\nblocked_from: executing', `${PLAN}\n${QUESTION}`));
    await write('next.md', idea('status: plan\napproved: 2026-10-01'));
    const { ws, t } = await load('next');
    expect(() => planStart(ws, t, 'claude')).toThrow(AgentError);
    expect(() => planStart(ws, t, 'claude')).toThrow(/only one idea executes at a time.*"busy" is blocked on your answer.*mdpm unblock busy/);
    expect(() => planMove(ws, t, 'executing', 'eli')).toThrow(/"busy"/);
  });

  it('approving an idea that already has a plan makes it an approved plan', async () => {
    await write('x.md', idea('status: idea'));
    const { t } = await load('x');
    expect(planApprove(t, 'eli').changes).toEqual({ status: 'plan', approved: today() });
  });

  it('blocks from idea, plan or executing only, and adds questions to a blocked idea', async () => {
    await write('r.md', idea('status: review'));
    await write('b.md', idea('status: blocked\nblocked_from: plan', `${PLAN}\n${QUESTION}`));
    const { ws } = await load('r');
    const [r, b] = [findTask(ws, 'r')!, findTask(ws, 'b')!];
    expect(() => planBlock(r, 'claude', ['q'])).toThrow(/Only ideas, plans and executing ideas can be blocked/);
    expect(() => planBlock(b, 'claude', [' '])).toThrow(/at least one question/);
    expect(planBlock(b, 'claude', ['and?'])).toMatchObject({ changes: {}, questions: ['and?'] });
  });

  it('move keeps the flow fields consistent', async () => {
    await write('p.md', idea('status: plan\napproved: 2026-10-01'));
    await write('d.md', idea('status: done\ncompleted: 2026-10-01'));
    await write('b.md', idea('status: blocked\nblocked_from: plan', `${PLAN}\n${QUESTION}`));
    const { ws } = await load('p');
    const get = (id: string) => findTask(ws, id)!;
    expect(planMove(ws, get('p'), 'idea', 'eli').changes).toEqual({ status: 'idea', approved: null });
    expect(planMove(ws, get('p'), 'executing', 'eli').changes).toEqual({ status: 'executing', branch: 'idea/p' });
    expect(planMove(ws, get('d'), 'review', 'eli').changes).toEqual({ status: 'review', completed: null });
    expect(planMove(ws, get('b'), 'plan', 'eli').changes).toEqual({ status: 'plan', blocked_from: null });
    expect(planMove(ws, get('p'), 'done', 'eli').changes).toEqual({ status: 'done', completed: today() });
    expect(() => planMove(ws, get('p'), 'blocked', 'eli')).toThrow(/mdpm block p/);
    expect(() => planMove(ws, get('p'), 'todo', 'eli')).toThrow(/not a status.*idea, plan, executing/);
  });

  it('keeps the rest of the file intact', () => {
    const text = '---\n# comment\ntitle: T\nstatus: executing\n---\n\n# T\n\nNotes.\n';
    const out = applyWriteBack(text, { changes: { status: 'review' }, log: 'did it\nsecond line', by: 'claude' }, new Date(2026, 9, 20, 2, 14));
    expect(out).toBe('---\n# comment\ntitle: T\nstatus: review\n---\n\n# T\n\nNotes.\n\n## Log\n\n- 2026-10-20 02:14 claude — did it\n  second line\n');
  });
});

describe('guard rails for agents', () => {
  it('refuses the person\'s commands and other ideas than the run\'s', async () => {
    await write('x.md', idea('status: executing'));
    await write('y.md', idea('status: idea'));
    const { ws } = await load('x');
    const x = findTask(ws, 'x')!;
    for (const c of ['approve', 'unblock', 'rework', 'accept', 'move', 'set']) expect(agentGuard(c, x, 'claude', 'x')).toMatch(new RegExp(`"mdpm ${c}" is the person's call`));
    for (const c of ['handoff', 'block', 'log', 'propose', 'start']) expect(agentGuard(c, x, 'claude', 'x')).toBeUndefined();
    expect(agentGuard('log', findTask(ws, 'y')!, 'claude', 'x')).toMatch(/this run is about "x".*mdpm log x/);
    expect(agentGuard('log', findTask(ws, 'y')!, 'claude')).toBeUndefined();
  });
});

describe('board drag rules', () => {
  const t = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'x', status, body: '', ...extra });

  it('maps the moves a person makes to flow commands', () => {
    expect(dropIntent(t('idea', { body: PLAN }), 'plan')).toEqual({ action: 'approve' });
    expect(dropIntent(t('plan'), 'idea')).toEqual({ action: 'replan' });
    expect(dropIntent(t('plan', { approved: '2026-10-01' }), 'executing')).toEqual({ action: 'start' });
    expect(dropIntent(t('executing'), 'plan')).toEqual({ action: 'move' });
    expect(dropIntent(t('review'), 'done')).toEqual({ action: 'accept' });
    expect(dropIntent(t('review'), 'plan')).toEqual({ action: 'rework' });
  });

  it('explains the moves that are not part of the flow', () => {
    expect(dropIntent(t('idea'), 'plan')).toMatchObject({ reason: expect.stringContaining('no plan yet') });
    expect(dropIntent(t('plan'), 'executing')).toMatchObject({ reason: expect.stringContaining('Approve the plan') });
    expect(dropIntent(t('idea'), 'review')).toMatchObject({ reason: expect.stringContaining('hands work off') });
    expect(dropIntent(t('blocked', { blockedFrom: 'executing' }), 'review')).toMatchObject({ reason: expect.stringContaining('blocked on your answer') });
  });
});

describe('mdpm migrate', () => {
  const OLD = 'name: Root\nstatuses: [backlog, todo, in-progress, blocked, review, done]\nrequiredByStatus:\n  done: [end]\n# keep me\nagent:\n  unassigned: true\n  maxTurns: 20\n';

  it('maps statuses, strips task-era fields and settings, and renames sections', async () => {
    await write('.proj', OLD);
    await write('sub/.proj', 'name: Sub\nagent:\n  modes: [refine]\n');
    await write('raw.md', idea('status: backlog', '\n## Description\n\nidea text\n'));
    await write('specced.md', idea('status: backlog'));
    await write('mine.md', idea('status: todo\nowner: eli'));
    await write('queued.md', idea('status: todo\nowner: claude\ndepends_on: [mine]'));
    await write('first.md', idea('status: in-progress\nowner: claude\nstart: 2026-10-01'));
    await write('second.md', idea('status: in-progress\nowner: claude\nstart: 2026-10-05'));
    await write('asked.md', idea('status: blocked\nowner: claude', `${PLAN}\n## Questions\n\n- [ ] which?\n`));
    await write('refined.md', idea('status: blocked\nowner: claude', `${PLAN}\n## Questions\n\n- [ ] (mdpm, 2026-10-19) Review the refined description and acceptance criteria. Edit…\n\n## Agent log\n\n- 2026-10-19 10:00 claude — refined\n`));
    await write('shipped.md', idea('status: done\nowner: claude\nstart: 2026-10-01\nend: 2026-10-03'));

    const plan = planMigration(await loadWorkspace(root), { branchExists: (b) => b === 'agent/first' });
    const to = Object.fromEntries(plan.ideas.map((i) => [i.id, i.to]));
    expect(to).toEqual({ raw: 'idea', specced: 'plan', mine: 'plan', queued: 'plan', first: 'executing', second: 'plan', asked: 'blocked', refined: 'plan', shipped: 'done' });
    expect(plan.projects.map((p) => [path.relative(root, p.file), p.removed])).toEqual([
      ['.proj', ['statuses', 'requiredByStatus', 'agent.unassigned']],
      [path.join('sub', '.proj'), ['agent.modes']],
    ]);
    expect(plan.problems).toEqual([]);

    await applyMigration(plan);
    const ws = await loadWorkspace(root);
    expect(ws.issues).toEqual([]);
    const get = (id: string) => findTask(ws, id)!;
    expect(get('queued')).toMatchObject({ status: 'plan', approved: today() });
    expect(get('queued').meta.depends_on).toBeUndefined();
    expect(get('mine').approved).toBeUndefined();
    expect(get('first')).toMatchObject({ status: 'executing', branch: 'agent/first', approved: today() });
    expect(get('second')).toMatchObject({ status: 'plan', approved: today() });
    expect(get('asked')).toMatchObject({ status: 'blocked', blockedFrom: 'plan' });
    expect(get('refined')).toMatchObject({ status: 'plan', approved: undefined });
    expect(openQuestions(get('refined').body)).toEqual([]);
    expect(get('refined').body).toContain('## Log\n');
    expect(get('raw').body).toContain('## Idea\n');
    expect(get('shipped')).toMatchObject({ status: 'done', completed: '2026-10-03' });
    const proj = await fs.readFile(path.join(root, '.proj'), 'utf8');
    expect(proj).toBe('name: Root\n# keep me\nagent:\n  maxTurns: 20\n');
    expect(await fs.readFile(path.join(root, 'sub', '.proj'), 'utf8')).toBe('name: Sub\n');

    // Running it again finds nothing to do.
    const again = planMigration(await loadWorkspace(root));
    expect([again.ideas, again.projects, again.problems]).toEqual([[], [], []]);
  });

  it('reports statuses it cannot map instead of guessing', async () => {
    await write('.proj', 'name: Root\nstatuses: [open, waiting, closed]\n');
    await write('o.md', idea('status: open', ''));
    await write('w.md', idea('status: waiting', ''));
    await write('c.md', idea('status: closed', ''));
    const plan = planMigration(await loadWorkspace(root));
    expect(Object.fromEntries(plan.ideas.map((i) => [i.id, i.to]))).toEqual({ o: 'idea', c: 'done' });
    expect(plan.problems.map((p) => path.basename(p.file))).toEqual(['w.md']);
    expect(plan.problems[0].message).toMatch(/"waiting" has no flow equivalent/);
  });
});
