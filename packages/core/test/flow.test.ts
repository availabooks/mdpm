import { promises as fs, mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUSES,
  FLOW_STAGES,
  FlowStage,
  acceptanceCriteria,
  createProject,
  findTask,
  flowStage,
  hasPlan,
  loadWorkspace,
  needsPerson,
  statusForStage,
} from '../src';

const AGENT_STATUSES = ['backlog', 'todo', 'in-progress', 'blocked', 'review', 'done'];
const PLAN = '# T\n\n## Acceptance criteria\n\n- [x] first\n- [ ] second\n';
const task = (status: string, extra: { start?: string; body?: string } = {}) => ({ status, body: '', ...extra });

describe('acceptance criteria', () => {
  it('counts checked and open boxes under the heading only', () => {
    const body = '- [x] not a criterion\n\n## Acceptance criteria\n\n- [x] a\n* [X] b\n- [ ] c\n\n## Questions\n\n- [ ] q?\n';
    expect(acceptanceCriteria(body)).toEqual({ done: 2, total: 3 });
  });

  it('ignores the empty placeholder from the new-task template', () => {
    expect(acceptanceCriteria('## Acceptance criteria\n\n- [ ] \n')).toEqual({ done: 0, total: 0 });
    expect(hasPlan({ body: '## Acceptance criteria\n\n- [ ] \n' })).toBe(false);
  });

  it('handles CRLF and any heading level', () => {
    expect(acceptanceCriteria('### Acceptance Criteria\r\n- [ ] x\r\n')).toEqual({ done: 0, total: 1 });
  });
});

describe('flow stages', () => {
  it('has the five stages in order', () => {
    expect([...FLOW_STAGES]).toEqual(['idea', 'planned', 'building', 'review', 'done']);
  });

  it('maps the default statuses onto the flow', () => {
    const stages = DEFAULT_STATUSES.map((s) => flowStage(task(s), DEFAULT_STATUSES));
    expect(stages).toEqual(['idea', 'planned', 'building', 'review', 'done']);
  });

  it('keeps a blocked task in the stage it was blocked from', () => {
    expect(flowStage(task('blocked'), AGENT_STATUSES)).toBe('idea');
    expect(flowStage(task('blocked', { body: PLAN }), AGENT_STATUSES)).toBe('planned');
    expect(flowStage(task('blocked', { body: PLAN, start: '2026-10-19' }), AGENT_STATUSES)).toBe('building');
  });

  it('treats the final status as done and falls back for custom statuses', () => {
    const custom = ['open', 'doing', 'shipped'];
    expect(flowStage(task('open'), custom)).toBe('idea');
    expect(flowStage(task('doing'), custom)).toBe('building');
    expect(flowStage(task('shipped'), custom)).toBe('done');
    expect(flowStage(task('typo'), custom)).toBe('idea');
  });

  it('picks the status for a dropped card, and round-trips with flowStage', () => {
    for (const stage of FLOW_STAGES) {
      const status = statusForStage(stage, AGENT_STATUSES)!;
      expect(status).not.toBe('blocked');
      expect(flowStage(task(status), AGENT_STATUSES)).toBe(stage);
    }
    expect(statusForStage('planned', AGENT_STATUSES)).toBe('todo');
    expect(statusForStage('building', AGENT_STATUSES)).toBe('in-progress');
  });

  it('returns undefined when a project has no status for a stage', () => {
    const custom = ['open', 'closed'];
    const got: Partial<Record<FlowStage, string | undefined>> = {};
    for (const s of FLOW_STAGES) got[s] = statusForStage(s, custom);
    expect(got).toEqual({ idea: 'open', planned: undefined, building: undefined, review: undefined, done: 'closed' });
    expect(statusForStage('idea', [])).toBeUndefined();
  });

  it('flags tasks waiting on a person', () => {
    const project = { statuses: AGENT_STATUSES };
    expect(needsPerson(task('review'), project)).toBe(true);
    expect(needsPerson(task('blocked'), project)).toBe(true);
    expect(needsPerson(task('in-progress'), project)).toBe(false);
    expect(needsPerson(task('done'), project)).toBe(false);
  });

  it('works on tasks loaded from disk', async () => {
    const root = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), 'mdpm-flow-')));
    await createProject(root, { name: 'Root', statuses: AGENT_STATUSES });
    const write = (name: string, fm: string, body = '') => fs.writeFile(path.join(root, `${name}.md`), `---\n${fm}\n---\n${body}`);
    await write('idea', 'status: backlog', '# Idea\n\nI want dark mode.\n');
    await write('plan', 'status: todo', PLAN);
    await write('stuck', 'status: blocked\nstart: 2026-10-19', PLAN);
    await write('pr', 'status: review\nbranch: agent/pr', PLAN);
    const ws = await loadWorkspace(root);
    const stage = (id: string) => {
      const t = findTask(ws, id)!;
      return flowStage(t, t.home.statuses);
    };
    expect(['idea', 'plan', 'stuck', 'pr'].map(stage)).toEqual(['idea', 'planned', 'building', 'review']);
  });
});
