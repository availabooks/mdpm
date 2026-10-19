import { execFileSync } from 'child_process';
import { existsSync, promises as fs, mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AgentError,
  MARKER_END,
  agentDefinitions,
  agentGuard,
  agentInit,
  agentLog,
  agentQueue,
  appendToSection,
  applyWriteBack,
  bodyAfter,
  detectLimit,
  expandArgs,
  findTask,
  formatStreamLine,
  lastEntryIsClaim,
  loadWorkspace,
  openQuestions,
  parseResetTime,
  planContinue,
  planBlock,
  planClaim,
  planHandoff,
  planRelease,
  previewTaskChange,
  readiness,
  REVIEW_REFINEMENT,
  resolveCommand,
  runAgents,
  runInteractive,
  streamLimit,
  taskBody,
  writeBack,
} from '../src';

let root: string;

async function write(rel: string, text: string) {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

const READY = '\n## Acceptance criteria\n\n- [ ] it works\n';
const task = (fields: string, body = READY) => `---\n${fields}\n---\n${body}`;

beforeEach(async () => {
  root = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), 'mdpm-agent-')));
  await write('.proj', 'name: Root\nagent:\n  unassigned: true\n');
});

describe('task body', () => {
  it('appends to an existing section and creates missing ones before the agent log', () => {
    let body = '\n# T\n\n## Agent log\n\n- 2026-10-19 10:00 claude — claimed\n';
    body = appendToSection(body, 'Agent log', ['- 2026-10-19 11:00 claude — more']);
    body = appendToSection(body, 'Questions', ['- [ ] why?']);
    expect(body).toBe('\n# T\n\n## Questions\n\n- [ ] why?\n\n## Agent log\n\n- 2026-10-19 10:00 claude — claimed\n- 2026-10-19 11:00 claude — more\n');
  });

  it('keeps CRLF line endings and ignores headings inside code blocks', () => {
    const body = '\r\n# T\r\n\r\n```\r\n## Questions\r\n```\r\n';
    const out = appendToSection(body, 'Questions', ['- [ ] q']);
    expect(out).toBe('\r\n# T\r\n\r\n```\r\n## Questions\r\n```\r\n\r\n## Questions\r\n\r\n- [ ] q\r\n');
  });

  it('reads open questions and log entries', () => {
    const body = '## Questions\n\n- [x] answered\n- [ ] (claude, 2026-10-19) open one\n- [ ] \n\n## Agent log\n\n- 2026-10-19 10:00 claude — claimed (run r-1)\n  continued line\n- 2026-10-19 eli — note\n';
    expect(openQuestions(body)).toEqual(['(claude, 2026-10-19) open one']);
    expect(agentLog(body)).toEqual([
      { when: '2026-10-19 10:00', by: 'claude', text: 'claimed (run r-1) continued line' },
      { when: '2026-10-19', by: 'eli', text: 'note' },
    ]);
  });
});

describe('readiness and templates', () => {
  it('needs an acceptance criterion with text', () => {
    expect(readiness('## Acceptance criteria\n\n- [ ] \n').ready).toBe(false);
    expect(readiness('## Acceptance criteria\n\n<!-- - [ ] commented out -->\n').ready).toBe(false);
    expect(readiness('## Questions\n\n- [ ] not a criterion\n').ready).toBe(false);
    expect(readiness('## Acceptance criteria\n\n- [x] done already\n')).toMatchObject({ ready: true, criteria: 1, verification: false });
    expect(readiness('## Acceptance criteria\n\n- [ ] a\n\n## Verification\n\nnpm test\n')).toMatchObject({ ready: true, verification: true });
  });

  it('the agent template has every section but is not ready until filled in', () => {
    const body = taskBody('Export CSV', 'agent');
    for (const h of ['Goal', 'Context', 'Acceptance criteria', 'Verification', 'Constraints', 'Questions']) expect(body).toContain(`## ${h}`);
    expect(readiness(body)).toMatchObject({ ready: false, verification: false });
  });
});

describe('mdpm next', () => {
  it('picks resume, then implement, then refine; assigned before unassigned; then priority, deadline, created', async () => {
    await write('a-refine.md', task('status: backlog\nowner: claude'));
    await write('b-unassigned.md', task('status: todo\npriority: 1'));
    await write('c-low.md', task('status: todo\nowner: claude\npriority: 3'));
    await write('d-high.md', task('status: todo\nowner: claude\npriority: 1\nend: 2026-12-01'));
    await write('e-high-sooner.md', task('status: todo\nowner: claude\npriority: high\nend: 2026-11-01'));
    await write('f-resume.md', task('status: in-progress\nowner: claude\nstart: 2026-10-01'));
    await write('g-not-ready.md', task('status: todo\nowner: claude', '\n# no criteria\n'));
    await write('h-other.md', task('status: todo\nowner: codex'));
    const ws = await loadWorkspace(root);
    const { picks } = agentQueue(ws, 'claude');
    expect(picks.map((p) => [p.task.id, p.mode])).toEqual([
      ['f-resume', 'resume'],
      ['e-high-sooner', 'implement'],
      ['d-high', 'implement'],
      ['c-low', 'implement'],
      ['b-unassigned', 'implement'],
      ['a-refine', 'refine'],
      ['g-not-ready', 'refine'],
    ]);
  });

  it('skips blocked, unfinished dependencies, invalid tasks, released tasks and disallowed modes, saying why', async () => {
    await write('.proj', 'name: Root\nagent:\n  modes: [implement]\n');
    await write('blocked.md', task('status: blocked\nowner: claude\nstart: 2026-10-01', '## Questions\n\n- [ ] q\n'));
    await write('dep.md', task('status: todo\nowner: eli'));
    await write('waits.md', task('status: todo\nowner: claude\ndepends_on: [dep]'));
    await write('bad.md', task('status: todo\nowner: claude\nstart: 2026-13-01'));
    await write('idea.md', task('status: backlog\nowner: claude'));
    await write('released.md', task('status: todo\nowner: claude', `${READY}\n## Agent log\n\n- 2026-10-19 10:00 claude — released: not mine\n`));
    await write('requeued.md', task('status: todo\nowner: claude', `${READY}\n## Agent log\n\n- 2026-10-19 10:00 claude — released: not mine\n- 2026-10-19 11:00 eli — answered, try again\n`));
    const ws = await loadWorkspace(root);
    const { picks, skipped } = agentQueue(ws, 'claude');
    expect(picks.map((p) => p.task.id)).toEqual(['requeued']);
    const why = Object.fromEntries(skipped.map((s) => [s.task.id, s.reason]));
    expect(why.blocked).toContain('Answer its open questions');
    expect(why.waits).toContain('depends on "dep"');
    expect(why.bad).toContain('validation errors');
    expect(why.idea).toContain('"refine" mode');
    expect(why.released).toContain('released it');
    expect(why.dep).toBeUndefined();
  });

  it('only takes unassigned tasks where the project allows it, and nothing where agents are disabled', async () => {
    await write('.proj', 'name: Root\n');
    await write('off/.proj', 'name: Off\nagent:\n  enabled: false\n');
    await write('free.md', task('status: todo'));
    await write('off/mine.md', task('status: todo\nowner: claude'));
    const ws = await loadWorkspace(root);
    const { picks, skipped } = agentQueue(ws, 'claude');
    expect(picks).toEqual([]);
    expect(skipped.map((s) => s.task.id)).toEqual(['mine']);
    expect(skipped[0].reason).toContain('agent.enabled: false');
  });

  it('inherits agent settings key by key', async () => {
    await write('.proj', 'name: Root\nagent:\n  maxTurns: 10\n  unassigned: true\n');
    await write('sub/.proj', 'name: Sub\nagent:\n  unassigned: false\n');
    const ws = await loadWorkspace(root);
    const sub = ws.projects.find((p) => p.name === 'Sub')!;
    expect(sub.agent).toMatchObject({ enabled: true, unassigned: false, maxTurns: 10 });
  });
});

describe('write-back commands', () => {
  const load = async (id: string) => {
    const ws = await loadWorkspace(root);
    return { ws, t: findTask(ws, id)! };
  };

  it('claim moves to in-progress and logs the run; refuses tasks someone else has', async () => {
    await write('t.md', task('status: todo'));
    await write('theirs.md', task('status: in-progress\nowner: codex\nstart: 2026-10-01'));
    let { t } = await load('t');
    const wb = planClaim(t, 'claude', 'r-1');
    expect(wb.changes).toMatchObject({ status: 'in-progress', owner: 'claude' });
    expect(wb.changes.start).toBeDefined();
    await writeBack(t.file, wb);
    ({ t } = await load('t'));
    expect(t.status).toBe('in-progress');
    expect(agentLog(t.body).at(-1)).toMatchObject({ by: 'claude', text: 'claimed (run r-1)' });
    expect(lastEntryIsClaim(t, 'claude')).toBe(true);
    expect(planClaim(t, 'claude', 'r-2').log).toBe('resumed (run r-2)');

    const theirs = (await load('theirs')).t;
    expect(() => planClaim(theirs, 'claude', 'r-3')).toThrow(AgentError);
    expect(() => planClaim(theirs, 'claude', 'r-3')).toThrow(/already claimed by codex/);
    expect(planClaim(theirs, 'claude', 'r-3', { force: true }).changes.owner).toBe('claude');
  });

  it('claim for refinement keeps the status; blocked and done tasks cannot be claimed', async () => {
    await write('idea.md', task('status: backlog'));
    await write('stuck.md', task('status: blocked\nstart: 2026-10-01', '## Questions\n\n- [ ] q\n'));
    expect(planClaim((await load('idea')).t, 'claude', 'r').changes).toEqual({ owner: 'claude' });
    const stuck = (await load('stuck')).t;
    expect(() => planClaim(stuck, 'claude', 'r')).toThrow(/Answer its questions/);
  });

  it('block adds questions and the blocked status; handoff records branch and pr; release returns to todo', async () => {
    await write('t.md', task('status: in-progress\nowner: claude\nstart: 2026-10-01'));
    let { ws, t } = await load('t');
    const block = planBlock(t, 'claude', ['Archived too?', 'Which delimiter?']);
    expect(previewTaskChange(ws, t, block.changes, bodyAfter(t, block))).toEqual([]);
    await writeBack(t.file, block);
    ({ ws, t } = await load('t'));
    expect(t.status).toBe('blocked');
    expect(openQuestions(t.body)).toHaveLength(2);
    expect(openQuestions(t.body)[0]).toMatch(/^\(claude, \d{4}-\d{2}-\d{2}\) Archived too\?$/);

    await writeBack(t.file, planHandoff(t, 'claude', 'CSV export done', { branch: 'agent/t', pr: 'https://example.com/pr/1' }));
    ({ t } = await load('t'));
    expect(t).toMatchObject({ status: 'review', meta: expect.objectContaining({ branch: 'agent/t', pr: 'https://example.com/pr/1' }) });
    expect(agentLog(t.body).at(-1)!.text).toBe('handed off for review: CSV export done');

    await writeBack(t.file, planRelease(t, 'claude', 'not for me'));
    ({ t } = await load('t'));
    expect(t.status).toBe('todo');
    expect(t.owner).toBe('claude');
    expect(() => planBlock(t, 'claude', [' '])).toThrow(/at least one question/);
    expect(() => planHandoff(t, 'claude', '')).toThrow(/summary/);
  });

  it('refuses statuses the project does not have, saying how to add them', async () => {
    await write('.proj', 'name: Root\nstatuses: [todo, in-progress, done]\n');
    await write('t.md', task('status: in-progress\nowner: claude'));
    const { t } = await load('t');
    expect(() => planBlock(t, 'claude', ['q'])).toThrow(/no "blocked" status.*Add "blocked" to "statuses"/);
  });

  it('keeps the rest of the file intact', () => {
    const text = '---\n# comment\ntitle: T\nstatus: todo\n---\n\n# T\n\nNotes.\n';
    const out = applyWriteBack(text, { changes: { status: 'review' }, log: 'did it\nsecond line', by: 'claude' }, new Date(2026, 9, 20, 2, 14));
    expect(out).toBe('---\n# comment\ntitle: T\nstatus: review\n---\n\n# T\n\nNotes.\n\n## Agent log\n\n- 2026-10-20 02:14 claude — did it\n  second line\n');
  });

  it('the agent guard refuses done and tasks the agent has not claimed', async () => {
    await write('mine.md', task('status: in-progress\nowner: claude'));
    await write('theirs.md', task('status: todo\nowner: eli'));
    const mine = (await load('mine')).t;
    expect(agentGuard(mine, { status: 'done' }, 'claude')).toMatch(/don't mark tasks "done".*mdpm handoff/);
    expect(agentGuard(mine, { status: 'review' }, 'claude')).toBeUndefined();
    const theirs = (await load('theirs')).t;
    expect(agentGuard(theirs, {}, 'claude')).toMatch(/hasn't claimed "theirs".*mdpm claim theirs/);
  });
});

describe('agent validation rules', () => {
  const issues = async (rel: string) => (await loadWorkspace(root)).issues.filter((i) => i.file === path.join(root, rel));

  it('warns when a blocked task has no open question', async () => {
    await write('a.md', task('status: blocked\nstart: 2026-10-01'));
    await write('b.md', task('status: blocked\nstart: 2026-10-01', '## Questions\n\n- [x] answered\n'));
    await write('c.md', task('status: blocked\nstart: 2026-10-01', '## Questions\n\n- [ ] still open\n'));
    expect((await issues('a.md')).map((i) => i.code)).toEqual(['task/blocked-without-question']);
    expect((await issues('b.md')).map((i) => i.code)).toEqual(['task/blocked-without-question']);
    expect(await issues('c.md')).toEqual([]);
  });

  it('warns when a todo task queued for an agent is not ready', async () => {
    await write('a.md', task('status: todo\nowner: claude', '\n# T\n'));
    await write('b.md', task('status: todo\nowner: eli', '\n# T\n'));
    await write('c.md', task('status: todo\nowner: claude'));
    const a = await issues('a.md');
    expect(a.map((i) => [i.code, i.level])).toEqual([['task/not-ready', 'warning']]);
    expect(a[0].message).toContain('--template agent');
    expect(await issues('b.md')).toEqual([]);
    expect(await issues('c.md')).toEqual([]);
  });

  it('checks agent settings and definitions', async () => {
    await write('.proj', 'name: Root\nagent:\n  enabled: yes please\n  modes: [implement, fix]\n  maxTurns: 0\n  maxTurn: 5\nagents:\n  default: robo\n  mine:\n    command: [mine, "{tsk}"]\n  broken: 7\n');
    await write('sub/.proj', 'name: Sub\nagents:\n  x: [x]\n');
    const root_ = await issues('.proj');
    expect(root_.map((i) => i.code).sort()).toEqual([
      'proj/agent-unknown',
      'proj/field-type',
      'proj/field-type',
      'proj/field-value',
      'proj/field-value',
      'proj/field-value',
      'proj/field-value',
      'proj/unknown-field',
    ]);
    expect(root_.map((i) => i.message).join('\n')).toContain('Did you mean "maxTurns"?');
    expect((await issues('sub/.proj')).map((i) => i.code)).toEqual(['proj/agents-not-root']);
  });

  it('accepts a well-formed agent setup', async () => {
    await write('.proj', 'name: Root\nagent:\n  enabled: true\n  modes: [implement, refine]\n  maxTurns: 20\n  allowedTools: ["Bash(npm test)"]\nagents:\n  default: mine\n  mine:\n    command: [mine, --task, "{taskFile}", "{prompt}"]\n  claude:\n    command: [claude, -p]\n    stdin: true\n');
    expect(await issues('.proj')).toEqual([]);
    const defs = agentDefinitions(await loadWorkspace(root));
    expect(defs.default).toBe('mine');
    expect(Object.keys(defs.agents).sort()).toEqual(['claude', 'codex', 'cursor', 'mine']);
    expect(defs.agents.claude).toMatchObject({ command: ['claude', '-p'], stdin: true, resume: undefined });
  });
});

describe('agent init', () => {
  it('writes the skill and AGENTS.md, and updates only the generated part when run again', async () => {
    await write('AGENTS.md', '# My repo\n\nRun npm test before committing.\n');
    const first = await agentInit(root, { claudeHook: true });
    expect(first.map((r) => [path.relative(root, r.file), r.action])).toEqual([
      [path.join('.claude', 'skills', 'mdpm', 'SKILL.md'), 'created'],
      ['AGENTS.md', 'updated'],
      [path.join('.claude', 'settings.json'), 'created'],
    ]);
    const skill = await fs.readFile(path.join(root, '.claude/skills/mdpm/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: mdpm\ndescription: /);
    for (const s of ['mdpm next', 'mdpm claim', 'mdpm log', 'mdpm block', 'mdpm handoff', 'mdpm release', 'refine', 'Never mark a task done', 'Block instead of guessing']) expect(skill).toContain(s);

    // Edits outside the markers survive; edits inside are replaced.
    const agentsMd = path.join(root, 'AGENTS.md');
    let text = await fs.readFile(agentsMd, 'utf8');
    expect(text.startsWith('# My repo\n\nRun npm test before committing.\n')).toBe(true);
    text = text.replace('Block instead of guessing', 'EDITED') + '\nMy own notes.\n';
    await fs.writeFile(agentsMd, text);
    const again = await agentInit(root, { claudeHook: true });
    expect(again.map((r) => r.action)).toEqual(['unchanged', 'updated', 'unchanged']);
    text = await fs.readFile(agentsMd, 'utf8');
    expect(text).toContain('Block instead of guessing');
    expect(text).not.toContain('EDITED');
    expect(text.endsWith(`${MARKER_END}\n\nMy own notes.\n`)).toBe(true);

    const settings = JSON.parse(await fs.readFile(path.join(root, '.claude/settings.json'), 'utf8'));
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('mdpm check --hook');
  });
});

describe('runner helpers', () => {
  it('expands placeholders without a shell', () => {
    expect(expandArgs(['x', '--tools', '{allowedTools}', '--turns={maxTurns}', '{prompt}'], { allowedTools: ['Bash(a b)', 'Read'], maxTurns: '5', prompt: 'say "hi"\nok' })).toEqual([
      'x',
      '--tools',
      'Bash(a b)',
      'Read',
      '--turns=5',
      'say "hi"\nok',
    ]);
  });

  it('recognizes usage-limit messages and their reset times', () => {
    const now = new Date(2026, 9, 19, 14, 0);
    const hit = detectLimit("You've hit your session limit · resets 3:45pm", now);
    expect(hit.limited).toBe(true);
    expect(hit.resetsAt).toEqual(new Date(2026, 9, 19, 15, 45));
    expect(detectLimit('Claude AI usage limit reached|1792512000').resetsAt).toEqual(new Date(1792512000 * 1000));
    expect(detectLimit('all good').limited).toBe(false);
    expect(parseResetTime('9am', now)).toEqual(new Date(2026, 9, 20, 9, 0));
    expect(parseResetTime('soon', now)).toBeUndefined();
  });

  it('shows Claude stream-json events as readable progress lines', () => {
    const ev = (o: unknown) => JSON.stringify(o);
    expect(formatStreamLine(ev({ type: 'system', subtype: 'init', session_id: 's-1' }))).toBe('· session s-1');
    expect(
      formatStreamLine(ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the parser.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } })),
    ).toBe('Looking at the parser.\n→ Bash: npm test');
    expect(formatStreamLine(ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/a.ts' } }] } }))).toBe('→ Edit: /x/a.ts');
    expect(formatStreamLine(ev({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom\nmore' }] } }))).toBe('  ✗ boom more');
    expect(formatStreamLine(ev({ type: 'user', message: { content: [{ type: 'tool_result', content: 'fine' }] } }))).toBeUndefined();
    expect(formatStreamLine(ev({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))).toBeUndefined();
    expect(formatStreamLine('plain text')).toBe('plain text');
  });

  it('reads usage limits from Claude rate_limit_event lines', () => {
    const line = (status: string) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1792444800 } });
    expect(streamLimit([line('allowed'), '{"type":"result"}'].join('\n'))).toEqual({ limited: false });
    expect(streamLimit([line('allowed'), line('rejected')].join('\n'))).toEqual({ limited: true, resetsAt: new Date(1792444800 * 1000) });
  });

  it('runs Windows .cmd programs through cmd.exe with every argument quoted', () => {
    const exists = (f: string) => f === 'C:\\npm\\agent.CMD';
    const r = resolveCommand('agent', ['a "b"', 'c&d'], { Path: 'C:\\bin;C:\\npm', PATHEXT: '.EXE;.CMD' }, 'win32', exists);
    expect(r.file).toBe('cmd.exe');
    expect(r.verbatim).toBe(true);
    expect(r.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(r.args[3]).toContain('"a ""b"""');
    expect(r.args[3]).toContain('"c^&d"');
    expect(resolveCommand('agent', ['x'], { Path: 'C:\\tools' }, 'win32', (f) => f === 'C:\\tools\\agent.EXE')).toEqual({ file: 'C:\\tools\\agent.EXE', args: ['x'] });
    expect(resolveCommand('agent', ['x'], {}, 'darwin')).toEqual({ file: 'agent', args: ['x'] });
  });
});

describe('agent run', () => {
  const sh = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /** A stand-in agent: commits a file in its worktree and hands the task off by editing the task file. */
  async function setup(script: string) {
    await write('.fake/agent.js', script);
    const agent = path.join(root, '.fake', 'agent.js');
    await write('.proj', `name: Root\nagents:\n  default: fake\n  fake:\n    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(agent)}, "{taskFile}"]\n    stdin: true\n`);
    await write('one.md', task('title: One\nstatus: todo\nowner: fake\npriority: 1'));
    await write('two.md', task('title: Two\nstatus: todo\nowner: fake\npriority: 9'));
    sh(['init', '-q']);
    sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
    sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  }

  it('claims, runs each task in its own worktree and branch, and records the run', async () => {
    await setup(`
      const fs = require('fs'), { execFileSync } = require('child_process');
      let prompt = ''; process.stdin.on('data', d => prompt += d).on('end', () => {
        if (!prompt.includes('Mode: implement')) process.exit(3);
        fs.writeFileSync('work.txt', process.env.MDPM_TASK);
        const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
        g('add', 'work.txt'); g('commit', '-qm', 'work');
        const file = process.argv[2];
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: in-progress', 'status: review') + '- 2026-10-19 10:00 fake — handed off for review: did ' + process.env.MDPM_TASK + '\\n');
      });`);
    const logs: string[] = [];
    const summary = await runAgents({ root, maxTasks: 5, echo: false, log: (m) => logs.push(m) });
    expect(summary.records.map((r) => [r.task, r.outcome, r.status, r.exitCode])).toEqual([
      ['one', 'handed off', 'review', 0],
      ['two', 'handed off', 'review', 0],
    ]);
    expect(summary.stopped).toBe('No more tasks for fake.');
    expect(sh(['branch', '--list', 'agent/*']).split('\n').map((b) => b.trim())).toEqual(['agent/one', 'agent/two']);
    expect(sh(['show', 'agent/one:work.txt'])).toBe('one');
    expect(existsSync(path.join(root, 'work.txt'))).toBe(false); // the main checkout is untouched
    expect(existsSync(path.join(root, '.mdpm/worktrees/one'))).toBe(false); // cleaned up after handoff
    const ws = await loadWorkspace(root);
    const one = findTask(ws, 'one')!;
    expect(one.meta.branch).toBe('agent/one');
    expect(agentLog(one.body).map((e) => e.by)).toEqual(['fake', 'fake', 'mdpm']);
    const runs = (await fs.readdir(path.join(root, '.mdpm/runs'))).filter((f) => f.endsWith('.json'));
    expect(runs).toHaveLength(2);
    expect(sh(['status', '--porcelain', '--', '.mdpm'])).toBe(''); // git-ignored
  });

  it('stops on a usage limit, leaves the task resumable and waits for the reset', async () => {
    await setup(`console.error("You've hit your session limit · resets 11:59pm"); process.exit(1);`);
    const summary = await runAgents({ root, maxTasks: 5, echo: false, log: () => {} });
    expect(summary.records).toHaveLength(1);
    expect(summary.records[0]).toMatchObject({ limited: true, outcome: 'usage limit', status: 'in-progress' });
    expect(summary.stopped).toContain('usage limit');
    const one = findTask(await loadWorkspace(root), 'one')!;
    expect(agentLog(one.body).at(-1)!.text).toContain('hit its usage limit');
    const again = await runAgents({ root, echo: false, log: () => {} });
    expect(again.records).toEqual([]);
    expect(again.stopped).toContain('resets at');
  });

  it('blocks a refined task so the person reviews it, even if the agent moved it to todo', async () => {
    await setup(`
      const fs = require('fs');
      const file = process.argv[2];
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: backlog', 'status: todo') + '- 2026-10-19 10:00 fake — refined: added criteria\\n');`);
    await write('idea.md', task('title: Idea\nstatus: backlog\nowner: fake\npriority: 0', '\n# Idea\n\n## Agent log\n\n'));
    const summary = await runAgents({ root, task: 'idea', echo: false, log: () => {} });
    expect(summary.records[0]).toMatchObject({ mode: 'refine', outcome: 'refined', status: 'blocked' });
    const idea = findTask(await loadWorkspace(root), 'idea')!;
    expect(openQuestions(idea.body)).toEqual([expect.stringContaining(REVIEW_REFINEMENT)]);
    expect(existsSync(path.join(root, '.mdpm/worktrees/idea'))).toBe(false);
  });

  it('logs when the agent exits without writing back, and a dry run changes nothing', async () => {
    await setup('process.exit(0);');
    const before = await fs.readFile(path.join(root, 'one.md'), 'utf8');
    const dry = await runAgents({ root, dryRun: true, echo: false, log: () => {} });
    expect(dry.records).toEqual([]);
    expect(await fs.readFile(path.join(root, 'one.md'), 'utf8')).toBe(before);

    const summary = await runAgents({ root, task: 'two', echo: false, log: () => {} });
    expect(summary.records[0]).toMatchObject({ task: 'two', outcome: 'no handoff', status: 'in-progress' });
    const two = findTask(await loadWorkspace(root), 'two')!;
    expect(agentLog(two.body).at(-1)!.text).toMatch(/exited \(code 0\) without handing off/);
    expect(existsSync(path.join(root, '.mdpm/worktrees/two'))).toBe(true); // kept so the next run resumes in it
  });
});

describe('agent continue', () => {
  const sh = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const record = async (over: Record<string, unknown> = {}) => {
    await write('.mdpm/runs/r-1.json', JSON.stringify({ id: 'r-1', agent: 'claude', task: 'one', sessionId: 's-1', ...over }));
  };

  beforeEach(async () => {
    await write('one.md', task('title: One\nstatus: review\nowner: claude\nstart: 2026-10-01', `${READY}\n## Agent log\n\n- 2026-10-19 10:00 claude — handed off for review: did it\n`));
    sh(['init', '-q']);
    sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
    sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  });

  it('reopens the last conversation in a worktree recreated on the task branch', async () => {
    await record();
    sh(['branch', 'agent/one']); // the branch outlives the worktree that a handoff removes
    const plan = await planContinue({ root, task: 'one' });
    expect(plan).toMatchObject({ agent: 'claude', branch: 'agent/one', reopened: true, recreated: true });
    expect(plan.command.slice(0, 2)).toEqual(['claude', '--continue']);
    expect(plan.command).toContain(root);
    expect(plan.command).toContain('Bash(mdpm *)');
    expect(existsSync(path.join(plan.worktree, '.git'))).toBe(true);
    expect(sh(['-C', plan.worktree, 'branch', '--show-current'])).toBe('agent/one');
    expect(plan.env).toMatchObject({ MDPM_TASK: 'one', MDPM_ROOT: root });

    const again = await planContinue({ root, task: 'one' });
    expect(again.recreated).toBe(false);
  });

  it('starts a new conversation from the task when there is no earlier run, or when asked to', async () => {
    const first = await planContinue({ root, task: 'one' });
    expect(first).toMatchObject({ agent: 'claude', reopened: false });
    expect(first.command[0]).toBe('claude');
    expect(first.command[1]).toContain('A person is here with you now');
    expect(first.command[1]).toContain('handed off for review: did it');
    expect(first.command[1]).toContain(path.join(root, 'one.md'));
    expect(first.command).not.toContain('--continue');

    await record();
    expect((await planContinue({ root, task: 'one' })).reopened).toBe(true);
    expect((await planContinue({ root, task: 'one', fresh: true })).reopened).toBe(false);
  });

  it('never sets MDPM_AGENT, because the person is directing the agent', async () => {
    process.env.MDPM_AGENT = 'claude';
    try {
      expect((await planContinue({ root, task: 'one' })).env.MDPM_AGENT).toBeUndefined();
    } finally {
      delete process.env.MDPM_AGENT;
    }
  });

  it('picks the agent of the last run, then the owner, and honours --agent', async () => {
    await write('.proj', 'name: Root\nagents:\n  mine:\n    command: [mine, "{prompt}"]\n    interactive: [mine, chat, "{prompt}"]\n');
    await record({ agent: 'mine', sessionId: undefined });
    expect((await planContinue({ root, task: 'one' })).agent).toBe('mine');
    expect((await planContinue({ root, task: 'one', agent: 'cursor' })).agent).toBe('cursor');
    await fs.rm(path.join(root, '.mdpm/runs/r-1.json'));
    expect((await planContinue({ root, task: 'one' })).agent).toBe('claude'); // owner
  });

  it('explains how to add an interactive command to an agent that has none', async () => {
    await write('.proj', 'name: Root\nagents:\n  mine:\n    command: [mine, "{prompt}"]\n');
    await expect(planContinue({ root, task: 'one', agent: 'mine' })).rejects.toThrow(/no "interactive" command.*agents\.mine.*interactive: \[mine, "\{prompt\}"\]/s);
    await expect(planContinue({ root, task: 'nope' })).rejects.toThrow(/No task with id or path "nope"/);
  });

  it('a dry run creates nothing', async () => {
    const plan = await planContinue({ root, task: 'one', dryRun: true });
    expect(existsSync(plan.worktree)).toBe(false);
    expect(sh(['branch', '--list', 'agent/*'])).toBe('');
  });

  it('runs the command attached to the terminal and returns its exit code', async () => {
    const plan = await planContinue({ root, task: 'one' });
    plan.command = [process.execPath, '-e', 'process.exit(process.env.MDPM_TASK === "one" && process.cwd().includes("worktrees") ? 7 : 1)'];
    expect(await runInteractive(plan)).toBe(7);
    plan.command = ['definitely-not-a-program-xyz'];
    expect(await runInteractive(plan)).toBeNull();
  });
});
