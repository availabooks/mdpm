// Shared state, filtering and toolbar for the board and waterfall webviews.
/* eslint-disable no-unused-vars */
const vscode = acquireVsCodeApi();

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_COLORS = ['--vscode-charts-blue', '--vscode-charts-yellow', '--vscode-charts-purple', '--vscode-charts-orange'];

const mdpm = {
  model: null,
  state: Object.assign({ project: '', owner: '', q: '' }, vscode.getState() || {}),
  render: () => {},

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
    const s = this.statuses(task);
    const i = s.indexOf(task.status);
    if (i === s.length - 1) return 'var(--vscode-charts-green)';
    if (i <= 0) return 'var(--vscode-descriptionForeground)';
    return `var(${STATUS_COLORS[(i - 1) % STATUS_COLORS.length]})`;
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
        <span class="spacer"></span>
        ${extraHtml}`;
      const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
      on('f-project', 'change', (e) => this.set({ project: e.target.value }));
      on('f-owner', 'change', (e) => this.set({ owner: e.target.value }));
      on('f-q', 'input', (e) => this.set({ q: e.target.value }));
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
    this.render();
  },
};

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'model') {
    mdpm.model = msg.data;
    mdpm.render();
  } else if (msg.type === 'focusProject') {
    mdpm.state.project = msg.project;
    mdpm.save();
    if (mdpm.model) mdpm.render();
  }
});
