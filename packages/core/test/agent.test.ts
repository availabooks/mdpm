import { execFileSync, spawnSync } from 'child_process';
import { existsSync, promises as fs, mkdtempSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MARKER_END,
  NO_PLAN_QUESTION,
  STALE_MS,
  activeDir,
  agentDefinitions,
  agentInit,
  ago,
  appendToSection,
  detectLimit,
  expandArgs,
  findTask,
  formatStreamLine,
  ideaBody,
  loadWorkspace,
  logEntries,
  markActive,
  openQuestions,
  parseResetTime,
  planApprove,
  planCheck,
  planContinue,
  planUnblock,
  readActive,
  resolveCommand,
  runAgents,
  runInteractive,
  streamLimit,
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
const sh = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitAll = () => {
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
};

beforeEach(async () => {
  root = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), 'mdpm-agent-')));
  await write('.proj', 'name: Root\n');
});

describe('idea body', () => {
  it('appends to an existing section and creates missing ones before the log', () => {
    let body = '\n# T\n\n## Log\n\n- 2026-10-19 10:00 claude — started\n';
    body = appendToSection(body, 'Log', ['- 2026-10-19 11:00 claude — more']);
    body = appendToSection(body, 'Questions', ['- [ ] why?']);
    expect(body).toBe('\n# T\n\n## Questions\n\n- [ ] why?\n\n## Log\n\n- 2026-10-19 10:00 claude — started\n- 2026-10-19 11:00 claude — more\n');
  });

  it('keeps CRLF line endings and ignores headings inside code blocks', () => {
    const body = '\r\n# T\r\n\r\n```\r\n## Questions\r\n```\r\n';
    const out = appendToSection(body, 'Questions', ['- [ ] q']);
    expect(out).toBe('\r\n# T\r\n\r\n```\r\n## Questions\r\n```\r\n\r\n## Questions\r\n\r\n- [ ] q\r\n');
  });

  it('reads open questions and log entries', () => {
    const body = '## Questions\n\n- [x] answered\n- [ ] (claude, 2026-10-19) open one\n- [ ] \n\n## Log\n\n- 2026-10-19 10:00 claude — started (run r-1)\n  continued line\n- 2026-10-19 eli — note\n';
    expect(openQuestions(body)).toEqual(['(claude, 2026-10-19) open one']);
    expect(logEntries(body)).toEqual([
      { when: '2026-10-19 10:00', by: 'claude', text: 'started (run r-1) continued line' },
      { when: '2026-10-19', by: 'eli', text: 'note' },
    ]);
  });

  it('a plan is complete with an acceptance criterion that has text', () => {
    expect(planCheck('## Acceptance criteria\n\n- [ ] \n').complete).toBe(false);
    expect(planCheck('## Acceptance criteria\n\n<!-- - [ ] commented out -->\n').complete).toBe(false);
    expect(planCheck('## Questions\n\n- [ ] not a criterion\n').complete).toBe(false);
    expect(planCheck('## Acceptance criteria\n\n- [x] done already\n')).toMatchObject({ complete: true, criteria: 1, verification: false });
    expect(planCheck('## Acceptance criteria\n\n- [ ] a\n\n## Verification\n\nnpm test\n')).toMatchObject({ complete: true, verification: true });
  });

  it('the idea template has every section but no plan until one is written', () => {
    const body = ideaBody('Export CSV');
    for (const h of ['Idea', 'Plan', 'Acceptance criteria', 'Verification', 'Questions']) expect(body).toContain(`## ${h}`);
    expect(planCheck(body)).toMatchObject({ complete: false, verification: false });
  });
});

describe('agent settings', () => {
  const issues = async (rel: string) => (await loadWorkspace(root)).issues.filter((i) => i.file === path.join(root, rel));

  it('inherits agent settings key by key', async () => {
    await write('.proj', 'name: Root\nagent:\n  maxTurns: 10\n  enabled: false\n');
    await write('sub/.proj', 'name: Sub\nagent:\n  enabled: true\n');
    const ws = await loadWorkspace(root);
    expect(ws.projects.find((p) => p.name === 'Sub')!.agent).toMatchObject({ enabled: true, maxTurns: 10 });
  });

  it('checks agent settings and definitions', async () => {
    await write('.proj', 'name: Root\nagent:\n  enabled: yes please\n  maxTurns: 0\n  maxTurn: 5\nagents:\n  default: robo\n  mine:\n    command: [mine, "{tsk}"]\n  broken: 7\n');
    await write('sub/.proj', 'name: Sub\nagents:\n  x: [x]\n');
    const root_ = await issues('.proj');
    expect(root_.map((i) => i.code).sort()).toEqual(['proj/agent-unknown', 'proj/field-type', 'proj/field-type', 'proj/field-value', 'proj/field-value', 'proj/field-value', 'proj/unknown-field']);
    expect(root_.map((i) => i.message).join('\n')).toContain('Did you mean "maxTurns"?');
    expect((await issues('sub/.proj')).map((i) => i.code)).toEqual(['proj/agents-not-root']);
  });

  it('accepts a well-formed agent setup', async () => {
    await write('.proj', 'name: Root\nagent:\n  enabled: true\n  maxTurns: 20\n  allowedTools: ["Bash(npm test)"]\nagents:\n  default: mine\n  mine:\n    command: [mine, --idea, "{taskFile}", "{prompt}"]\n  claude:\n    command: [claude, -p]\n    stdin: true\n');
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
    expect(skill).toMatch(/^---\nname: mdpm\ndescription: Plan and execute mdpm ideas/);
    for (const s of ['mdpm next', 'mdpm propose', 'mdpm start', 'mdpm log', 'mdpm block', 'mdpm handoff', 'idea → plan → executing → review → done', 'One idea at a time', 'Block instead of guessing']) expect(skill).toContain(s);
    expect(skill).not.toMatch(/mdpm claim|mdpm release/);

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

  it('replaces an older skill description', async () => {
    await write('.claude/skills/mdpm/SKILL.md', '---\nname: mdpm\ndescription: Find, claim and work on mdpm tasks\n---\n\nold body\n');
    await agentInit(root);
    const skill = await fs.readFile(path.join(root, '.claude/skills/mdpm/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: mdpm\ndescription: Plan and execute/);
    expect(skill).not.toContain('Find, claim');
    expect(skill).toContain('old body'); // the person's own text outside the markers stays
  });
});

describe('runner helpers', () => {
  it('expands placeholders without a shell', () => {
    expect(expandArgs(['x', '--tools', '{allowedTools}', '--turns={maxTurns}', '{prompt}'], { allowedTools: ['Bash(a b)', 'Read'], maxTurns: '5', prompt: 'say "hi"\nok' })).toEqual(['x', '--tools', 'Bash(a b)', 'Read', '--turns=5', 'say "hi"\nok']);
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
    expect(formatStreamLine(ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking at the parser.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }))).toBe(
      'Looking at the parser.\n→ Bash: npm test',
    );
    expect(formatStreamLine(ev({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: 'boom\nmore' }] } }))).toBe('  ✗ boom more');
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
    expect(r.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(r.args[3]).toContain('"a ""b"""');
    expect(r.args[3]).toContain('"c^&d"');
    expect(resolveCommand('agent', ['x'], {}, 'darwin')).toEqual({ file: 'agent', args: ['x'] });
  });
});

/**
 * A stand-in agent. Plan mode: writes acceptance criteria and proposes (by editing the idea file,
 * as `mdpm propose` would). Execute mode: whatever `execute` says. It also records each prompt.
 */
const fakeAgent = (execute: string, plan = PROPOSE) => `
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  const file = process.argv[2];
  const edit = (from, to, extra = '') => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(from, to) + extra);
  let prompt = ''; process.stdin.on('data', d => prompt += d).on('end', () => {
    fs.appendFileSync(path.join(process.env.MDPM_ROOT, 'prompts.log'), process.env.MDPM_TASK + ' ' + (prompt.match(/Mode: (\\w+)/) || [])[1] + (prompt.includes('An earlier run started') ? ' resume' : '') + '\\n');
    if (prompt.includes('Mode: plan')) { ${plan} } else { ${execute} }
  });`;
const PROPOSE = `edit('status: idea', 'status: plan'); edit('## Log', '## Acceptance criteria\\n\\n- [ ] works\\n\\n## Log');`;
const HANDOFF = `fs.writeFileSync('work.txt', process.env.MDPM_TASK); g('add', 'work.txt'); g('commit', '-qm', 'work');
  edit('status: executing', 'status: review', '- 2026-10-19 10:00 fake — handed off for review: did ' + process.env.MDPM_TASK + '\\n');`;

async function repo(agentScript: string, ideas: Record<string, string>) {
  await write('.fake/agent.js', agentScript);
  const agent = path.join(root, '.fake', 'agent.js');
  await write('.proj', `name: Root\nagents:\n  default: fake\n  fake:\n    command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(agent)}, "{taskFile}"]\n    stdin: true\n    interactive: [fake-chat, "{prompt}"]\n`);
  await write('.gitignore', 'prompts.log\n');
  for (const [id, text] of Object.entries(ideas)) await write(`${id}.md`, text);
  sh(['init', '-q', '-b', 'main']);
  commitAll();
}

const prompts = async () => (await fs.readFile(path.join(root, 'prompts.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
const quiet = { echo: false, log: () => {} };

describe('agent run', () => {
  it('plans an idea without touching code, then executes the approved plan on its own branch', async () => {
    await repo(fakeAgent(HANDOFF), { one: idea('title: One\nstatus: idea', '\n# One\n\n## Idea\n\nDo one.\n') });

    const planned = await runAgents({ root, untilIdle: true, ...quiet });
    expect(planned.records.map((r) => [r.idea, r.mode, r.outcome, r.status])).toEqual([['one', 'plan', 'planned', 'plan']]);
    expect(planned.stopped).toMatch(/Nothing left to do.*mdpm approve one/s);
    expect(sh(['branch', '--list', 'idea/*'])).toBe(''); // planning makes no branch

    let one = findTask(await loadWorkspace(root), 'one')!;
    await writeBack(one.file, planApprove(one, 'eli'));
    const built = await runAgents({ root, untilIdle: true, ...quiet });
    expect(built.records.map((r) => [r.idea, r.mode, r.outcome, r.status, r.branch])).toEqual([['one', 'execute', 'handed off', 'review', 'idea/one']]);
    expect(sh(['show', 'idea/one:work.txt'])).toBe('one');
    expect(existsSync(path.join(root, 'work.txt'))).toBe(false); // the main checkout is untouched
    expect(existsSync(path.join(root, '.mdpm/worktrees'))).toBe(false); // no per-idea worktrees
    expect(sh(['branch', '--show-current'], path.join(root, '.mdpm/agent'))).toBe(''); // branch freed for review
    one = findTask(await loadWorkspace(root), 'one')!;
    expect(one).toMatchObject({ branch: 'idea/one' });
    expect(logEntries(one.body).map((e) => [e.by, e.text.split(' ')[0]])).toEqual([
      ['fake', 'started'],
      ['eli', 'approved'],
      ['fake', 'started'],
      ['fake', 'handed'],
      ['mdpm', 'run'],
    ]);
    expect(await prompts()).toEqual(['one plan', 'one execute']);
    expect(sh(['status', '--porcelain', '--', '.mdpm'])).toBe(''); // git-ignored
  });

  it('keeps one idea in the slot: a blocked execution waits, its work is saved as wip, and ideas are still planned', async () => {
    const block = `fs.writeFileSync('half.txt', 'half'); edit('status: executing', 'status: blocked\\nblocked_from: executing', '\\n## Questions\\n\\n- [ ] which way?\\n');`;
    await repo(fakeAgent(block), {
      a: idea('title: A\nstatus: plan\napproved: 2026-10-01'),
      b: idea('title: B\nstatus: plan\napproved: 2026-10-02'),
      c: idea('title: C\nstatus: idea', '\n# C\n'),
    });
    const summary = await runAgents({ root, untilIdle: true, ...quiet });
    expect(summary.records.map((r) => [r.idea, r.mode, r.outcome])).toEqual([
      ['a', 'execute', 'blocked'],
      ['c', 'plan', 'planned'],
    ]);
    const ws = await loadWorkspace(root);
    expect(findTask(ws, 'b')!.status).toBe('plan'); // waits for the slot
    expect(sh(['log', '-1', '--format=%s', 'idea/a'])).toBe('wip: blocked on questions');
    expect(sh(['show', 'idea/a:half.txt'])).toBe('half');
    expect(summary.stopped).toMatch(/blocked on your answer/);

    // Answered: it resumes in the slot before anything else executes.
    const a = findTask(ws, 'a')!;
    await writeBack(a.file, planUnblock(ws, a, 'eli', 'left'));
    await fs.writeFile(path.join(root, '.fake/agent.js'), fakeAgent(`edit('status: executing', 'status: review');`));
    const next = await runAgents({ root, ...quiet });
    expect(next.records.map((r) => [r.idea, r.mode, r.resume])).toEqual([['a', 'execute', true]]);
    expect((await prompts()).at(-1)).toBe('a execute resume');
  });

  it('only one run at a time', async () => {
    await repo('process.exit(0);', { one: idea('status: idea', '') });
    const h = await markActive(path.join(root, '.mdpm'), { task: 'other', agent: 'claude', mode: 'execute', run: 'r-x' });
    await expect(runAgents({ root, ...quiet })).rejects.toThrow(/claude is already executing "other".*only one run happens at a time/);
    await expect(planContinue({ root, task: 'one' })).rejects.toThrow(/only one run happens at a time/);
    h.stop();
  });

  it('blocks an idea whose plan run wrote no plan, and stops the loop', async () => {
    await repo(fakeAgent(HANDOFF, 'process.exit(0);'), { one: idea('status: idea\ncreated: 2026-10-01', '\n# One\n'), two: idea('status: idea\ncreated: 2026-12-01', '\n# Two\n') });
    const summary = await runAgents({ root, untilIdle: true, ...quiet });
    expect(summary.records.map((r) => [r.idea, r.outcome, r.status])).toEqual([['one', 'no plan', 'blocked']]);
    expect(summary.stopped).toMatch(/ended without writing anything back/);
    const one = findTask(await loadWorkspace(root), 'one')!;
    expect(one.blockedFrom).toBe('idea');
    expect(openQuestions(one.body)).toEqual([expect.stringContaining(NO_PLAN_QUESTION)]);
  });

  it('proposes a plan the agent wrote but did not propose', async () => {
    await repo(fakeAgent(HANDOFF, `edit('## Idea', '## Acceptance criteria\\n\\n- [ ] works\\n\\n## Idea');`), { one: idea('status: idea', '\n# One\n\n## Idea\n\nx\n') });
    const summary = await runAgents({ root, ...quiet });
    expect(summary.records[0]).toMatchObject({ outcome: 'planned', status: 'plan' });
    expect(logEntries(findTask(await loadWorkspace(root), 'one')!.body).at(-1)!.text).toContain('written but not proposed');
  });

  it('leaves an execution without handoff executing, to resume; a dry run changes nothing', async () => {
    await repo('process.stdin.resume();', { one: idea('title: One\nstatus: plan\napproved: 2026-10-01') });
    const before = await fs.readFile(path.join(root, 'one.md'), 'utf8');
    const dry = await runAgents({ root, dryRun: true, ...quiet });
    expect(dry.records).toEqual([]);
    expect(await fs.readFile(path.join(root, 'one.md'), 'utf8')).toBe(before);

    const summary = await runAgents({ root, idea: 'one', ...quiet });
    expect(summary.records[0]).toMatchObject({ outcome: 'no handoff', status: 'executing' });
    expect(logEntries(findTask(await loadWorkspace(root), 'one')!.body).at(-1)!.text).toMatch(/exited \(code 0\) without finishing.*Left executing/);
    expect(sh(['branch', '--show-current'], path.join(root, '.mdpm/agent'))).toBe('idea/one');
  });

  it('refuses to run an idea that waits on the person, and points out old per-task worktrees', async () => {
    await repo('process.exit(0);', { one: idea('status: plan') });
    await expect(runAgents({ root, idea: 'one', ...quiet })).rejects.toThrow(/can't work on "one" now: its plan waits for your approval/);
    await fs.mkdir(path.join(root, '.mdpm', 'worktrees', 'old-task'), { recursive: true });
    const logs: string[] = [];
    await runAgents({ root, echo: false, log: (m) => logs.push(m) });
    expect(logs[0]).toMatch(/worktrees from the task-based runner.*git worktree remove/);
  });

  it('stops on a usage limit, leaves the idea where it was and waits for the reset', async () => {
    await repo(`console.error("You've hit your session limit · resets 11:59pm"); process.exit(1);`, { one: idea('status: plan\napproved: 2026-10-01') });
    const summary = await runAgents({ root, untilIdle: true, ...quiet });
    expect(summary.records).toHaveLength(1);
    expect(summary.records[0]).toMatchObject({ limited: true, outcome: 'usage limit', status: 'executing' });
    expect(summary.stopped).toContain('usage limit');
    expect(logEntries(findTask(await loadWorkspace(root), 'one')!.body).at(-1)!.text).toContain('hit its usage limit');
    const again = await runAgents({ root, ...quiet });
    expect(again.records).toEqual([]);
    expect(again.stopped).toContain('resets at');
  });
});

describe('agent continue', () => {
  const record = async (over: Record<string, unknown> = {}) => {
    await write('.mdpm/runs/r-1.json', JSON.stringify({ id: 'r-1', agent: 'claude', idea: 'one', sessionId: 's-1', ...over }));
  };

  beforeEach(async () => {
    await write('one.md', idea('title: One\nstatus: review\nbranch: idea/one', `${PLAN}\n## Log\n\n- 2026-10-19 10:00 claude — handed off for review: did it\n`));
    sh(['init', '-q', '-b', 'main']);
    commitAll();
    sh(['branch', 'idea/one']);
  });

  it('reopens the last run on the idea, in the agent worktree on its branch', async () => {
    await record();
    const plan = await planContinue({ root, task: 'one' });
    expect(plan).toMatchObject({ agent: 'claude', branch: 'idea/one', reopened: true, recreated: true });
    expect(plan.command.slice(0, 3)).toEqual(['claude', '--resume', 's-1']);
    expect(plan.command).toContain(root);
    expect(plan.worktree).toBe(path.join(root, '.mdpm', 'agent'));
    expect(sh(['branch', '--show-current'], plan.worktree)).toBe('idea/one');
    expect(plan.env).toMatchObject({ MDPM_TASK: 'one', MDPM_ROOT: root });
    expect((await planContinue({ root, task: 'one' })).recreated).toBe(false);
  });

  it('starts a new conversation from the idea when there is no earlier run, or when asked to', async () => {
    const first = await planContinue({ root, task: 'one' });
    expect(first).toMatchObject({ agent: 'claude', reopened: false });
    expect(first.command[1]).toContain('A person is here with you now');
    expect(first.command[1]).toContain('handed off for review: did it');
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

  it('picks the agent of the last run, else the default, and honours --agent', async () => {
    await write('.proj', 'name: Root\nagents:\n  mine:\n    command: [mine, "{prompt}"]\n    interactive: [mine, chat, "{prompt}"]\n');
    await record({ agent: 'mine', sessionId: undefined });
    expect((await planContinue({ root, task: 'one' })).agent).toBe('mine');
    expect((await planContinue({ root, task: 'one', agent: 'cursor' })).agent).toBe('cursor');
    await fs.rm(path.join(root, '.mdpm/runs/r-1.json'));
    expect((await planContinue({ root, task: 'one' })).agent).toBe('claude');
  });

  it('explains how to add an interactive command, and a dry run creates nothing', async () => {
    await write('.proj', 'name: Root\nagents:\n  mine:\n    command: [mine, "{prompt}"]\n');
    await expect(planContinue({ root, task: 'one', agent: 'mine' })).rejects.toThrow(/no "interactive" command.*agents\.mine.*interactive: \[mine, "\{prompt\}"\]/s);
    await expect(planContinue({ root, task: 'nope' })).rejects.toThrow(/No idea with id or path "nope"/);
    const plan = await planContinue({ root, task: 'one', dryRun: true });
    expect(existsSync(plan.worktree)).toBe(false);
  });

  it('runs the command attached to the terminal, marked as a chat, and returns its exit code', async () => {
    const plan = await planContinue({ root, task: 'one' });
    const marker = path.join(activeDir(path.join(root, '.mdpm')), 'one.json');
    plan.command = [process.execPath, '-e', `const fs=require('fs');process.exit(JSON.parse(fs.readFileSync(${JSON.stringify(marker)},'utf8')).mode==='chat'&&process.env.MDPM_TASK==='one'&&process.cwd().endsWith('agent')?7:1)`];
    expect(await runInteractive(plan)).toBe(7);
    expect(existsSync(marker)).toBe(false);
    plan.command = ['definitely-not-a-program-xyz'];
    expect(await runInteractive(plan)).toBeNull();
  });
});

describe('agent activity', () => {
  const state = () => path.join(root, '.mdpm');
  const marker = (name = 'one') => path.join(activeDir(state()), `${name}.json`);

  it('marks an idea active until stopped, and reports who is doing what', async () => {
    const h = await markActive(state(), { task: 'one', agent: 'claude', mode: 'execute', run: 'r-1' });
    const [run] = await readActive(state());
    expect(run).toMatchObject({ task: 'one', agent: 'claude', mode: 'execute', run: 'r-1', pid: process.pid });
    h.stop();
    h.stop(); // safe twice
    expect(existsSync(marker())).toBe(false);
    expect(await readActive(state())).toEqual([]);
  });

  it('ignores markers whose process is gone or whose heartbeat stopped', async () => {
    const h = await markActive(state(), { task: 'one', agent: 'claude', mode: 'plan', run: 'r-1' });
    const dead = spawnSync(process.execPath, ['-e', '']).pid!; // a process that has already exited
    const file = JSON.parse(await fs.readFile(marker(), 'utf8'));
    await fs.writeFile(marker('dead'), JSON.stringify({ ...file, task: 'dead', pid: dead }));
    await fs.writeFile(marker('old'), JSON.stringify({ ...file, task: 'old', updated: new Date(Date.now() - STALE_MS - 5000).toISOString() }));
    await fs.writeFile(marker('junk'), '{ not json');
    expect((await readActive(state())).map((r) => r.task)).toEqual(['one']);
    expect((await readActive(state(), Date.now() + STALE_MS + 5000)).map((r) => r.task)).toEqual([]);
    h.stop();
  });

  it('formats how long ago something started', () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    expect([30, 59 * 60, 125 * 60, 4].map((s) => ago(new Date(now - s * 1000).toISOString(), now))).toEqual(['30s', '59m', '2h 5m', '4s']);
  });

  it('a run is marked active while the agent works, and cleared afterwards', async () => {
    await repo(
      `const fs = require('fs'), path = require('path');
      process.stdin.resume().on('end', () => {
        const m = path.join(process.env.MDPM_ROOT, '.mdpm', 'active', process.env.MDPM_TASK + '.json');
        fs.writeFileSync(path.join(process.env.MDPM_ROOT, 'seen.json'), fs.readFileSync(m, 'utf8'));
      });`,
      { one: idea('status: plan\napproved: 2026-10-01') },
    );
    await runAgents({ root, idea: 'one', ...quiet });
    expect(JSON.parse(await fs.readFile(path.join(root, 'seen.json'), 'utf8'))).toMatchObject({ task: 'one', agent: 'fake', mode: 'execute' });
    expect(await readActive(state())).toEqual([]);
  });
});
