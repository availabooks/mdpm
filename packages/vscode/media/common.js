// Shared state, filtering and toolbar for the board and waterfall webviews.
/* eslint-disable no-unused-vars */
const vscode = acquireVsCodeApi();

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Yellow is reserved for "blocked", so it stands out wherever it appears.
const STATUS_COLORS = ['--vscode-charts-blue', '--vscode-charts-purple', '--vscode-charts-orange'];
const BLOCKED = 'blocked';
const BLOCKED_COLOR = 'var(--vscode-charts-yellow)';
const PRIORITY_WORDS = { critical: 0, urgent: 0, high: 1, medium: 2, normal: 2, low: 3 };

const mdpm = {
  model: null,
  state: Object.assign({ project: '', owner: '', q: '' }, vscode.getState() || {}),
  /** Keys of the tasks picked with Ctrl/Cmd+click. */
  selected: new Set(),
  render: () => {},
  today: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),

  priorityRank(p) {
    if (typeof p === 'number') return p;
    if (p === undefined) return 99;
    const word = PRIORITY_WORDS[String(p).toLowerCase()];
    if (word !== undefined) return word;
    const n = parseFloat(String(p).replace(/^p/i, ''));
    return isNaN(n) ? 50 : n;
  },

  /** Sorts in place by priority, then due date, then title. */
  sorted(list) {
    return list.sort(
      (a, b) =>
        this.priorityRank(a.priority) - this.priorityRank(b.priority) ||
        (a.end ?? '9999').localeCompare(b.end ?? '9999') ||
        a.title.localeCompare(b.title),
    );
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
    const { project, owner, q } = this.state;
    const inProject = project ? this.subtree(project) : null;
    const needle = q.trim().toLowerCase();
    return this.model.tasks.filter(
      (t) =>
        (!inProject || t.projects.some((p) => inProject.has(p))) &&
        (!owner || (owner === '-' ? !t.owner : t.owner === owner)) &&
        (!needle || [t.title, t.id, t.owner, ...t.tags].some((s) => s && String(s).toLowerCase().includes(needle))),
    );
  },

  statuses(task) {
    return this.project(task.home)?.statuses ?? this.model.statuses;
  },

  isDone(task) {
    const s = this.statuses(task);
    return task.status === s[s.length - 1];
  },

  statusColor(task) {
    if (task.status === BLOCKED) return BLOCKED_COLOR;
    const s = this.statuses(task).filter((x) => x !== BLOCKED);
    const i = s.indexOf(task.status);
    if (i === s.length - 1) return 'var(--vscode-charts-green)';
    if (i <= 0) return 'var(--vscode-descriptionForeground)';
    return `var(${STATUS_COLORS[(i - 1) % STATUS_COLORS.length]})`;
  },

  /** Ctrl/Cmd+click toggles the task in the selection; a plain click clears it and opens the task. */
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

  /** Makes the click that follows a pointer drag not count as a click on empty space. */
  ignoreClick() {
    this.ignoringClick = true;
    setTimeout(() => (this.ignoringClick = false));
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

  /** Selected tasks, in model order. */
  selectedTasks() {
    return this.model.tasks.filter((t) => this.selected.has(t.key));
  },

  /** Updates the selected style and the toolbar's selection controls without re-rendering. */
  paintSelection() {
    for (const el of document.querySelectorAll('.card[data-key], .wf-label[data-key], .bar[data-key]')) {
      el.classList.toggle('selected', this.selected.has(el.dataset.key));
    }
    const n = this.selected.size;
    const box = document.getElementById('sel');
    if (!box) return;
    box.hidden = !n;
    document.getElementById('sel-n').textContent = `${n} selected`;
  },

  /** Agents only pick up backlog, todo and in-progress tasks. */
  canSendToAgent(task) {
    return ['backlog', 'todo', 'in-progress'].includes(task.status);
  },

  /** Builds the toolbar once; later calls only refresh the dropdown options. */
  toolbar(extraHtml, wireExtra) {
    const bar = document.getElementById('toolbar');
    if (!bar.dataset.built) {
      bar.dataset.built = '1';
      bar.innerHTML = `
        <label>Project <select id="f-project"></select></label>
        <label>Owner <select id="f-owner"></select></label>
        <input id="f-q" type="search" placeholder="Filter…" value="${esc(this.state.q)}">
        <span id="sel" class="sel" hidden>
          <span id="sel-n" class="sel-n"></span>
          <button id="b-sel-status" title="Set the status of all selected tasks">Set status…</button>
          <button id="b-sel-owner" title="Set the owner of all selected tasks">Set owner…</button>
          <button id="b-sel-clear" title="Clear the selection (Escape)">Clear</button>
        </span>
        <span class="spacer"></span>
        ${extraHtml}`;
      const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
      on('f-project', 'change', (e) => this.set({ project: e.target.value }));
      on('f-owner', 'change', (e) => this.set({ owner: e.target.value }));
      on('f-q', 'input', (e) => this.set({ q: e.target.value }));
      on('b-sel-status', 'click', () => this.post({ type: 'setStatusMany', files: [...this.selected] }));
      on('b-sel-owner', 'click', () => this.post({ type: 'setOwnerMany', files: [...this.selected] }));
      on('b-sel-clear', 'click', () => this.clearSelection());
      wireExtra?.();
    }
    const m = this.model;
    if (this.state.project && !this.project(this.state.project)) this.state.project = '';
    document.getElementById('f-project').innerHTML =
      `<option value="">All projects</option>` +
      m.projects
        .map((p) => `<option value="${esc(p.key)}" ${p.key === this.state.project ? 'selected' : ''}>${'   '.repeat(p.depth)}${esc(p.name)}</option>`)
        .join('');
    document.getElementById('f-owner').innerHTML =
      `<option value="">Anyone</option><option value="-" ${this.state.owner === '-' ? 'selected' : ''}>Unassigned</option>` +
      m.owners.map((o) => `<option ${o === this.state.owner ? 'selected' : ''}>${esc(o)}</option>`).join('');
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

// A click on empty board/timeline space clears the selection.
document.getElementById('app').addEventListener('click', (e) => {
  if (!mdpm.ignoringClick && !e.target.closest('.card, .wf-label[data-key], .bar, .wf-track.unscheduled, button, a, input, select')) mdpm.clearSelection();
});
