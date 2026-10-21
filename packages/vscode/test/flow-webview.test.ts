import { readFileSync } from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';
import { FLOW_STAGES, FLOW_STAGE_INFO } from '../../core/src';

/**
 * Runs media/common.js + media/flow.js in a tiny fake DOM. Elements created from the rendered
 * HTML only know their dataset and listeners, which is all the board's wiring uses.
 */
type Listener = (e: unknown) => void;
interface FakeEl {
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  title: string;
  dataset: Record<string, string>;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; has(c: string): boolean };
  listeners: Record<string, Listener[]>;
  addEventListener(ev: string, fn: Listener): void;
  querySelectorAll(sel: string): FakeEl[];
  querySelector(sel: string): FakeEl | null;
  contains(): boolean;
  closest(): FakeEl;
}

function el(dataset: Record<string, string> = {}, parent?: FakeEl): FakeEl {
  const classes = new Set<string>();
  const self: FakeEl = {
    innerHTML: '',
    textContent: '',
    hidden: false,
    disabled: false,
    title: '',
    dataset,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      has: (c) => classes.has(c),
    },
    listeners: {},
    addEventListener(ev, fn) {
      (this.listeners[ev] ??= []).push(fn);
    },
    querySelectorAll(sel) {
      if (sel === '.card') return [...self.innerHTML.matchAll(/class="card[^"]*" draggable="true" data-key="([^"]*)"/g)].map((m) => el({ key: m[1] }));
      if (sel === '.column') return [...self.innerHTML.matchAll(/data-stage="([^"]*)"/g)].map((m) => el({ stage: m[1] }));
      if (sel === '.card .act') {
        // Each button knows the card it sits on, for closest('.card').
        return self.innerHTML.split(/(?=<div class="card[ "])/).flatMap((chunk) => {
          const key = /data-key="([^"]*)"/.exec(chunk)?.[1];
          if (!key) return [];
          const card = el({ key });
          return [...chunk.matchAll(/data-action="([^"]*)"/g)].map((m) => el({ action: m[1] }, card));
        });
      }
      return [];
    },
    querySelector: () => null,
    contains: () => false,
    closest: () => parent ?? self,
  };
  return self;
}

function boot() {
  const ids = new Map<string, FakeEl>();
  const posted: any[] = [];
  let onMessage: Listener = () => {};
  const document = {
    getElementById: (id: string) => ids.get(id) ?? ids.set(id, el()).get(id)!,
    // Used by the selection painting in common.js; the fake page has no selectable elements.
    querySelectorAll: (): FakeEl[] => [],
  };
  const context = vm.createContext({
    document,
    // common.js also listens for keys and clicks; only the extension's messages matter here.
    window: { addEventListener: (ev: string, fn: Listener) => void (ev === 'message' && (onMessage = fn)) },
    acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => {}, postMessage: (m: unknown) => posted.push(m) }),
  });
  const media = path.join(__dirname, '..', 'media');
  vm.runInContext(['common.js', 'flow.js'].map((f) => readFileSync(path.join(media, f), 'utf8')).join('\n;\n'), context);
  const app = document.getElementById('app');
  return { app, posted, send: (data: unknown) => onMessage({ data: { type: 'model', data } }), $: document.getElementById };
}

const project = { key: '/p/.proj', name: 'P', depth: 0, relPath: '.' };
const card = (id: string, stage: string, extra: Record<string, unknown> = {}) => ({
  key: `/p/${id}.md`,
  id,
  title: `Idea ${id}`,
  status: stage,
  stage,
  approved: false,
  tags: [],
  home: project.key,
  projects: [project.key],
  shared: false,
  relPath: `${id}.md`,
  criteria: { done: 0, total: 0 },
  questions: 0,
  needsYou: false,
  ...extra,
});
const model = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  projects: [project],
  tasks,
  stages: FLOW_STAGES.map((s) => FLOW_STAGE_INFO[s]),
  slot: null,
  next: null,
  defaultAgent: 'claude',
  ...extra,
});

/** The HTML of the column for `stage`. */
const lane = (html: string, stage: string) => html.split('<section').find((s) => s.includes(`data-stage="${stage}"`)) ?? '';
const cardOf = (html: string, id: string) => html.split(/(?=<div class="card[ "])/).find((c) => c.includes(`data-key="/p/${id}.md"`)) ?? '';

describe('flow board webview', () => {
  it('renders the five columns in order with who acts on each', () => {
    const { app, posted, send } = boot();
    expect(posted).toEqual([{ type: 'ready' }]);
    send(model([]));
    expect([...app.innerHTML.matchAll(/data-stage="([^"]*)"/g)].map((m) => m[1])).toEqual(['idea', 'plan', 'executing', 'review', 'done']);
    expect([...app.innerHTML.matchAll(/class="col-name">([^<]*)</g)].map((m) => m[1])).toEqual(['Idea', 'Plan', 'Executing', 'Review', 'Done']);
    expect(lane(app.innerHTML, 'plan')).toContain('actor-you');
    expect(lane(app.innerHTML, 'executing')).toContain('actor-agent');
  });

  it('puts each idea in its column, says where it stands, and counts what waits on the person', () => {
    const { app, send, $ } = boot();
    send(
      model(
        [
          card('a', 'idea'),
          card('b', 'plan', { criteria: { done: 0, total: 4 }, needsYou: true }),
          card('q', 'plan', { approved: true, queue: 1, criteria: { done: 0, total: 2 } }),
          card('c', 'executing', { status: 'blocked', questions: 2, needsYou: true, branch: 'idea/c' }),
          card('d', 'review', { branch: 'idea/d', needsYou: true, pr: 'https://x/pr/1' }),
          card('e', 'done'),
        ],
        { slot: { key: '/p/c.md', id: 'c', title: 'Idea c', status: 'blocked' } },
      ),
    );
    for (const [id, stage] of [['a', 'idea'], ['b', 'plan'], ['q', 'plan'], ['c', 'executing'], ['d', 'review'], ['e', 'done']]) {
      expect(lane(app.innerHTML, stage)).toContain(`data-key="/p/${id}.md"`);
    }
    expect(cardOf(app.innerHTML, 'b')).toContain('Awaiting your approval');
    expect(cardOf(app.innerHTML, 'q')).toContain('Approved · #1 in queue');
    expect(cardOf(app.innerHTML, 'c')).toContain('Needs your answer (2)');
    expect(cardOf(app.innerHTML, 'd')).toContain('idea/d');
    expect($('needs-you').textContent).toBe('Waiting on you: 3');
    expect($('slot').innerHTML).toContain('Slot: c is blocked on you');
    // What waits on the person comes first in its column.
    expect(lane(app.innerHTML, 'plan').indexOf('/p/b.md')).toBeLessThan(lane(app.innerHTML, 'plan').indexOf('/p/q.md'));
  });

  it('offers the next step on each card and sends it to the extension', () => {
    const { app, posted, send } = boot();
    let buttons: FakeEl[] = [];
    const query = app.querySelectorAll;
    app.querySelectorAll = (sel: string) => {
      const found = query(sel);
      if (sel === '.card .act') buttons = found;
      return found;
    };
    send(
      model([
        card('a', 'idea'),
        card('b', 'plan', { needsYou: true }),
        card('c', 'executing', { status: 'blocked', needsYou: true }),
        card('d', 'review', { needsYou: true, pr: 'https://x/pr/1' }),
        card('e', 'executing', { running: { agent: 'claude', mode: 'execute', started: new Date().toISOString() } }),
      ]),
    );
    const actions = (id: string) => buttons.filter((b) => b.closest().dataset.key === `/p/${id}.md`).map((b) => b.dataset.action);
    expect(actions('a')).toEqual(['planNow']);
    expect(actions('b')).toEqual(['approve', 'replan']);
    expect(actions('c')).toEqual(['unblock']);
    expect(actions('d')).toEqual(['accept', 'rework', 'openPr']);
    expect(actions('e')).toEqual([]); // the agent is on it
    const approve = buttons.find((b) => b.dataset.action === 'approve')!;
    approve.listeners.click[0]({ stopPropagation() {} });
    expect(posted.at(-1)).toEqual({ type: 'action', action: 'approve', file: '/p/b.md' });
  });

  it('asks the extension what a drop means, without moving the card itself', () => {
    const { app, posted, send } = boot();
    let columns: FakeEl[] = [];
    const query = app.querySelectorAll;
    app.querySelectorAll = (sel: string) => {
      const found = query(sel);
      if (sel === '.column') columns = found;
      return found;
    };
    const drop = (stage: string) => columns.find((c) => c.dataset.stage === stage)!.listeners.drop[0]({ preventDefault() {}, dataTransfer: { getData: () => '/p/d.md' } });

    send(model([card('d', 'review')]));
    drop('done');
    expect(posted.at(-1)).toEqual({ type: 'drop', file: '/p/d.md', stage: 'done' });
    expect(lane(app.innerHTML, 'review')).toContain('data-key="/p/d.md"'); // stays until the file changes

    const before = posted.length;
    drop('review');
    expect(posted.length).toBe(before); // dropping on its own column does nothing
  });

  it('runs the agent on what is next, one run at a time', () => {
    const { send, posted, $ } = boot();
    send(model([card('a', 'idea')], { next: { key: '/p/a.md', id: 'a', mode: 'plan', resume: false } }));
    expect($('b-run').disabled).toBe(false);
    expect($('b-run').title).toContain('plan "a"');
    $('b-run').listeners.click[0]({});
    expect(posted.at(-1)).toEqual({ type: 'action', action: 'runNext' });

    send(model([card('a', 'idea', { running: { agent: 'claude', mode: 'plan', started: new Date().toISOString() } })], { next: { key: '/p/a.md', id: 'a', mode: 'plan', resume: false } }));
    expect($('b-run').disabled).toBe(true);
    send(model([card('b', 'plan', { needsYou: true })]));
    expect($('b-run').disabled).toBe(true);
    expect($('b-run').title).toContain('everything waits on you');
  });

  it('creates new ideas in the focused project', () => {
    const { posted, send, $ } = boot();
    send(model([]));
    $('b-new').listeners.click[0]({});
    expect(posted.at(-1)).toEqual({ type: 'newIdea', project: undefined });
  });

  it('shows who is working on an idea right now', () => {
    const { app, send } = boot();
    const started = new Date(Date.now() - 3 * 60000).toISOString();
    send(model([card('run', 'executing', { running: { agent: 'claude', mode: 'execute', started } }), card('idle', 'idea')]));
    expect(cardOf(app.innerHTML, 'run')).toContain('claude executing');
    expect(cardOf(app.innerHTML, 'run')).toMatch(/class="age" data-since="[^"]+">3m</);
    expect(cardOf(app.innerHTML, 'run')).toContain(' working');
    expect(cardOf(app.innerHTML, 'idle')).not.toContain('class="running"');
  });
});
