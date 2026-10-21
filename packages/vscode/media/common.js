// Shared state, filtering, selection and toolbar for the flow board webview.
/* eslint-disable no-unused-vars */
const vscode = acquireVsCodeApi();

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const BLOCKED = 'blocked';
const PRIORITY_WORDS = { critical: 0, urgent: 0, high: 1, medium: 2, normal: 2, low: 3 };

const mdpm = {
  model: null,
  state: Object.assign({ project: '', q: '' }, vscode.getState() || {}),
  /** Keys of the ideas picked with Ctrl/Cmd+click. */
  selected: new Set(),
  render: () => {},

  priorityRank(p) {
    if (typeof p === 'number') return p;
    if (p === undefined) return 99;
    const word = PRIORITY_WORDS[String(p).toLowerCase()];
    if (word !== undefined) return word;
    const n = parseFloat(String(p).replace(/^p/i, ''));
    return isNaN(n) ? 50 : n;
  },

  /** Sorts in place by priority, then title. */
  sorted(list) {
    return list.sort((a, b) => this.priorityRank(a.priority) - this.priorityRank(b.priority) || a.title.localeCompare(b.title));
  },

  save() {
    vscode.setState(this.state);
  },

  post(msg) {
    vscode.postMessage(msg);
  },

  project(key) {
    return this.model?.projects.find((p) => p.key === key);
  },

  /** Keys of a project and all of its sub projects. */
  subtree(key) {
    const out = new Set([key]);
    for (const p of this.model.projects) if (p.parent && out.has(p.parent)) out.add(p.key);
    return out;
  },

  filtered() {
    const { project, q } = this.state;
    const inProject = project ? this.subtree(project) : null;
    const needle = q.trim().toLowerCase();
    return this.model.tasks.filter(
      (t) => (!inProject || t.projects.some((p) => inProject.has(p))) && (!needle || [t.title, t.id, ...t.tags].some((s) => s && String(s).toLowerCase().includes(needle))),
    );
  },

  /** Ctrl/Cmd+click toggles the idea in the selection; a plain click clears it and opens the idea. */
  clickTask(e, key) {
    if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(key)) this.selected.delete(key);
      else this.selected.add(key);
      this.paintSelection();
    } else {
      this.clearSelection();
      this.post({ type: 'open', file: key });
    }
  },

  clearSelection() {
    if (!this.selected.size) return;
    this.selected.clear();
    this.paintSelection();
  },

  /** Drops selected keys that no longer exist or are hidden by the filters. */
  pruneSelection() {
    if (!this.selected.size || !this.model) return;
    const visible = new Set(this.filtered().map((t) => t.key));
    for (const key of this.selected) if (!visible.has(key)) this.selected.delete(key);
  },

  /** Selected ideas, in model order. */
  selectedTasks() {
    return this.model.tasks.filter((t) => this.selected.has(t.key));
  },

  /** Updates the selected style and the toolbar's selection controls without re-rendering. */
  paintSelection() {
    for (const el of document.querySelectorAll('.card[data-key]')) el.classList.toggle('selected', this.selected.has(el.dataset.key));
    const n = this.selected.size;
    const box = document.getElementById('sel');
    if (!box) return;
    box.hidden = !n;
    document.getElementById('sel-n').textContent = `${n} selected`;
    const sel = this.model ? this.selectedTasks() : [];
    document.getElementById('b-sel-approve').hidden = !sel.some((t) => t.status === 'idea' || (t.status === 'plan' && !t.approved));
    document.getElementById('b-sel-accept').hidden = !sel.some((t) => t.status === 'review');
  },

  /** `45s`, `3m`, `1h 5m`: how long ago `iso` was. */
  ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  },

  /** What an agent is doing with an idea right now ("claude executing · 3m", pulsing). */
  runBadge(t) {
    if (!t.running) return '';
    const verb = { plan: 'planning', execute: 'executing', chat: 'chatting with you' }[t.running.mode] ?? 'working';
    return `<span class="running" title="${esc(`${t.running.agent} is ${verb}. Started ${t.running.started}`)}"><span class="pulse"></span>${esc(t.running.agent)} ${verb} · <span class="age" data-since="${esc(t.running.started)}">${this.ago(t.running.started)}</span></span>`;
  },

  /** Builds the toolbar once; later calls only refresh the project options. */
  toolbar(extraHtml, wireExtra) {
    const bar = document.getElementById('toolbar');
    if (!bar.dataset.built) {
      bar.dataset.built = '1';
      bar.innerHTML = `
        <label>Project <select id="f-project"></select></label>
        <input id="f-q" type="search" placeholder="Filter…" value="${esc(this.state.q)}">
        <span id="sel" class="sel" hidden>
          <span id="sel-n" class="sel-n"></span>
          <button id="b-sel-approve" title="Approve the selected plans">Approve</button>
          <button id="b-sel-accept" title="Accept the selected work in review">Accept</button>
          <button id="b-sel-clear" title="Clear the selection (Escape)">Clear</button>
        </span>
        <span class="spacer"></span>
        ${extraHtml}`;
      const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
      on('f-project', 'change', (e) => this.set({ project: e.target.value }));
      on('f-q', 'input', (e) => this.set({ q: e.target.value }));
      on('b-sel-approve', 'click', () => this.post({ type: 'approveMany', files: this.selectedTasks().filter((t) => t.status === 'idea' || (t.status === 'plan' && !t.approved)).map((t) => t.key) }));
      on('b-sel-accept', 'click', () => this.post({ type: 'acceptMany', files: this.selectedTasks().filter((t) => t.status === 'review').map((t) => t.key) }));
      on('b-sel-clear', 'click', () => this.clearSelection());
      wireExtra?.();
    }
    const m = this.model;
    if (this.state.project && !this.project(this.state.project)) this.state.project = '';
    document.getElementById('f-project').innerHTML =
      `<option value="">All projects</option>` +
      m.projects.map((p) => `<option value="${esc(p.key)}" ${p.key === this.state.project ? 'selected' : ''}>${'   '.repeat(p.depth)}${esc(p.name)}</option>`).join('');
  },

  set(patch) {
    Object.assign(this.state, patch);
    this.save();
    this.refresh();
  },

  /** Re-renders after the model or the filters changed. */
  refresh() {
    this.pruneSelection();
    this.render();
    this.paintSelection();
  },
};

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'model') {
    mdpm.model = msg.data;
    mdpm.refresh();
  } else if (msg.type === 'focusProject') {
    mdpm.state.project = msg.project;
    mdpm.save();
    if (mdpm.model) mdpm.refresh();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') mdpm.clearSelection();
});

// A click on empty board space clears the selection.
document.getElementById('app').addEventListener('click', (e) => {
  if (!e.target.closest('.card, button, a, input, select')) mdpm.clearSelection();
});

// Keep the "3m" in running badges current without re-rendering.
if (typeof setInterval === 'function') {
  setInterval(() => {
    for (const el of document.querySelectorAll('.age[data-since]')) el.textContent = mdpm.ago(el.dataset.since);
  }, 15000);
}
