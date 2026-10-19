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
  dataset: Record<string, string>;
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; has(c: string): boolean };
  listeners: Record<string, Listener[]>;
  addEventListener(ev: string, fn: Listener): void;
  querySelectorAll(sel: string): FakeEl[];
  querySelector(sel: string): FakeEl | null;
  contains(): boolean;
}

function el(dataset: Record<string, string> = {}): FakeEl {
  const classes = new Set<string>();
  const self: FakeEl = {
    innerHTML: '',
    textContent: '',
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
      const pattern =
        sel === '.card' ? /class="card[^"]*" draggable="true" data-key="([^"]*)"/g : sel === '.column' ? /data-stage="([^"]*)"/g : null;
      if (!pattern) return [];
      const key = sel === '.card' ? 'key' : 'stage';
      return [...self.innerHTML.matchAll(pattern)].map((m) => el({ [key]: m[1] }));
    },
    querySelector: () => null,
    contains: () => false,
  };
  return self;
}

function boot(view = 'flow.js') {
  const ids = new Map<string, FakeEl>();
  const posted: any[] = [];
  let onMessage: Listener = () => {};
  const document = { getElementById: (id: string) => ids.get(id) ?? ids.set(id, el()).get(id)! };
  const context = vm.createContext({
    document,
    window: { addEventListener: (_: string, fn: Listener) => (onMessage = fn) },
    acquireVsCodeApi: () => ({ getState: () => undefined, setState: () => {}, postMessage: (m: unknown) => posted.push(m) }),
  });
  const media = path.join(__dirname, '..', 'media');
  vm.runInContext(['common.js', view].map((f) => readFileSync(path.join(media, f), 'utf8')).join('\n;\n'), context);
  const app = document.getElementById('app');
  return { app, posted, send: (data: unknown) => onMessage({ data: { type: 'model', data } }), $: document.getElementById };
}

const STATUSES = ['backlog', 'todo', 'in-progress', 'blocked', 'review', 'done'];
const project = { key: '/p/.proj', name: 'P', depth: 0, statuses: STATUSES, relPath: '.' };
const card = (id: string, stage: string, extra: Record<string, unknown> = {}) => ({
  key: `/p/${id}.md`,
  id,
  title: `Task ${id}`,
  status: 'todo',
  tags: [],
  dependsOn: [],
  home: project.key,
  projects: [project.key],
  shared: false,
  relPath: `${id}.md`,
  stage,
  criteria: { done: 0, total: 0 },
  ...extra,
});
const model = (tasks: unknown[]) => ({
  projects: [project],
  tasks,
  statuses: STATUSES,
  owners: [],
  stages: FLOW_STAGES.map((s) => FLOW_STAGE_INFO[s]),
});

/** The HTML of the lane for `stage`. */
const lane = (html: string, stage: string) => html.split('<section').find((s) => s.includes(`data-stage="${stage}"`)) ?? '';

describe('AI flow board webview', () => {
  it('renders the five lanes in order with who acts on each', () => {
    const { app, posted, send } = boot();
    expect(posted).toEqual([{ type: 'ready' }]);
    send(model([]));
    const order = [...app.innerHTML.matchAll(/data-stage="([^"]*)"/g)].map((m) => m[1]);
    expect(order).toEqual(['idea', 'planned', 'building', 'review', 'done']);
    const labels = [...app.innerHTML.matchAll(/class="col-name">([^<]*)</g)].map((m) => m[1]);
    expect(labels).toEqual(['Idea', 'Planned', 'Building', 'Review', 'Done']);
    expect(lane(app.innerHTML, 'review')).toContain('actor-you');
    expect(lane(app.innerHTML, 'building')).toContain('actor-agent');
  });

  it('puts each task in its stage and highlights what waits on the person', () => {
    const { app, send, $ } = boot();
    send(
      model([
        card('a', 'idea', { status: 'backlog' }),
        card('b', 'planned', { criteria: { done: 1, total: 4 } }),
        card('c', 'building', { status: 'blocked', start: '2026-10-19' }),
        card('d', 'review', { status: 'review', branch: 'agent/d' }),
        card('e', 'done', { status: 'done' }),
      ]),
    );
    for (const [id, stage] of [['a', 'idea'], ['b', 'planned'], ['c', 'building'], ['d', 'review'], ['e', 'done']]) {
      expect(lane(app.innerHTML, stage)).toContain(`data-key="/p/${id}.md"`);
    }
    expect(lane(app.innerHTML, 'planned')).toContain('1/4');
    expect(lane(app.innerHTML, 'building')).toContain('Needs your answer');
    expect(lane(app.innerHTML, 'review')).toContain('agent/d');
    expect($('needs-you').textContent).toBe('2 waiting on you');
  });

  it('asks the extension to move a dropped card to the lane', () => {
    const { app, posted, send } = boot();
    // Keep the column elements wire() attaches its drop listeners to.
    let columns: FakeEl[] = [];
    const query = app.querySelectorAll;
    app.querySelectorAll = (sel: string) => {
      const found = query(sel);
      if (sel === '.column') columns = found;
      return found;
    };
    const drop = (stage: string) =>
      columns.find((c) => c.dataset.stage === stage)!.listeners.drop[0]({ preventDefault() {}, dataTransfer: { getData: () => '/p/a.md' } });

    send(model([card('a', 'idea', { status: 'backlog' })]));
    drop('review');
    expect(posted.at(-1)).toEqual({ type: 'setStage', file: '/p/a.md', stage: 'review' });
    expect(lane(app.innerHTML, 'review')).toContain('data-key="/p/a.md"'); // optimistic move

    const before = posted.length;
    drop('review');
    expect(posted.length).toBe(before); // dropping on its own lane does nothing
  });

  it('creates new ideas in the focused project', () => {
    const { posted, send, $ } = boot();
    send(model([]));
    $('b-new').listeners.click[0]({});
    expect(posted.at(-1)).toEqual({ type: 'newTask', project: undefined });
  });
});

describe('classic Kanban board webview', () => {
  it('still renders one column per status, sorted by priority', () => {
    const { app, send } = boot('board.js');
    send(model([card('low', 'planned', { priority: 'low' }), card('high', 'planned', { priority: 'high' })]));
    const columns = [...app.innerHTML.matchAll(/class="column" data-status="([^"]*)"/g)].map((m) => m[1]);
    expect(columns).toEqual(STATUSES);
    expect(app.innerHTML.indexOf('/p/high.md')).toBeLessThan(app.innerHTML.indexOf('/p/low.md'));
  });
});
