// Kanban board: one column per status, drag cards to change status.
(() => {
  const app = document.getElementById('app');
  const PRIORITY_WORDS = { critical: 0, urgent: 0, high: 1, medium: 2, normal: 2, low: 3 };

  const priorityRank = (p) => {
    if (typeof p === 'number') return p;
    if (p === undefined) return 99;
    const word = PRIORITY_WORDS[String(p).toLowerCase()];
    if (word !== undefined) return word;
    const n = parseFloat(String(p).replace(/^p/i, ''));
    return isNaN(n) ? 50 : n;
  };

  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  function card(t) {
    const focused = mdpm.state.project;
    const overdue = t.end && t.end < today && !mdpm.isDone(t);
    const homeName = mdpm.project(t.home)?.name;
    const meta = [
      `<span class="id">${esc(t.id)}</span>`,
      t.priority !== undefined ? `<span class="badge prio">${esc(String(t.priority).match(/^\d/) ? `P${t.priority}` : t.priority)}</span>` : '',
      t.end ? `<span class="${overdue ? 'due overdue' : 'due'}" title="${esc(`${t.start ?? '?'} → ${t.end}`)}">⏱ ${esc(t.end)}</span>` : '',
      t.shared ? `<span class="shared" title="Shared with ${t.projects.length} projects">🔗${t.projects.length}</span>` : '',
      t.owner
        ? `<span class="owner${t.agentOwned ? ' agent' : ''}" title="${esc(t.agentOwned ? `Agent: ${t.owner}` : t.owner)}">${t.agentOwned ? '🤖 ' : ''}${esc(t.owner)}</span>`
        : '',
    ].join('');
    const agent = mdpm.model.defaultAgent;
    const actions =
      t.status === BLOCKED
        ? `<button class="act" data-action="unblock" title="Unblock: open the questions and move back to todo">Unblock</button>`
        : mdpm.canSendToAgent(t)
          ? `<button class="act" data-action="send" title="Send to ${esc(agent)} (runs it now in a terminal)">▶ ${esc(agent)}</button><button class="act more" data-action="sendAs" title="Send to another agent…">▾</button>`
          : '';
    return `
      <div class="card${t.status === BLOCKED ? ' blocked' : ''}" draggable="true" data-key="${esc(t.key)}" title="${esc(t.relPath)}" style="--accent:${mdpm.statusColor(t)}">
        ${actions ? `<div class="card-actions">${actions}</div>` : ''}
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-meta">${meta}</div>
        ${t.tags.length ? `<div class="tags">${t.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}
        ${t.home !== focused && homeName ? `<div class="card-project">${esc(homeName)}</div>` : ''}
      </div>`;
  }

  function render() {
    const m = mdpm.model;
    mdpm.toolbar(`<button id="b-new" title="New task">＋ New task</button>`, () => {
      document.getElementById('b-new').addEventListener('click', () => mdpm.post({ type: 'newTask', project: mdpm.state.project || undefined }));
    });
    if (!m.projects.length) {
      app.innerHTML = `<div class="empty">No projects found. Create a folder with a <code>.proj</code> file, or use “mdpm: New Project”.</div>`;
      return;
    }

    const focused = mdpm.project(mdpm.state.project);
    const columns = [...(focused ? focused.statuses : m.statuses)];
    const tasks = mdpm.filtered();
    for (const t of tasks) if (!columns.includes(t.status)) columns.push(t.status);

    const sorted = (list) =>
      list.sort(
        (a, b) =>
          priorityRank(a.priority) - priorityRank(b.priority) ||
          (a.end ?? '9999').localeCompare(b.end ?? '9999') ||
          a.title.localeCompare(b.title),
      );

    app.innerHTML = `<div class="board">${columns
      .map((status) => {
        const col = sorted(tasks.filter((t) => t.status === status));
        return `
          <section class="column${status === BLOCKED ? ' blocked' : ''}" data-status="${esc(status)}">
            <header><span class="col-name">${esc(status)}</span><span class="count">${col.length}</span>
              <button class="col-add" data-status="${esc(status)}" title="New task in “${esc(status)}”">＋</button></header>
            <div class="cards">${col.map(card).join('')}</div>
          </section>`;
      })
      .join('')}</div>`;
    wire();
  }

  /** Keys being dragged: the whole selection when a selected card is dragged, else just that card. */
  let dragKeys = [];

  function wire() {
    for (const b of app.querySelectorAll('.card .act')) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        mdpm.post({ type: 'agent', action: b.dataset.action, file: b.closest('.card').dataset.key });
      });
    }
    for (const el of app.querySelectorAll('.card')) {
      el.addEventListener('click', (e) => mdpm.clickTask(e, el.dataset.key));
      el.addEventListener('dragstart', (e) => {
        dragKeys = mdpm.selected.has(el.dataset.key) ? [...mdpm.selected] : [el.dataset.key];
        e.dataTransfer.setData('text/plain', el.dataset.key);
        e.dataTransfer.effectAllowed = 'move';
        for (const c of app.querySelectorAll('.card')) if (dragKeys.includes(c.dataset.key)) c.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        for (const c of app.querySelectorAll('.card.dragging')) c.classList.remove('dragging');
      });
    }
    for (const col of app.querySelectorAll('.column')) {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('over');
      });
      col.addEventListener('dragleave', (e) => {
        if (!col.contains(e.relatedTarget)) col.classList.remove('over');
      });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('over');
        const key = e.dataTransfer.getData('text/plain');
        const keys = dragKeys.includes(key) ? dragKeys : [key];
        dragKeys = [];
        const status = col.dataset.status;
        const tasks = mdpm.model.tasks.filter((t) => keys.includes(t.key) && t.status !== status);
        if (!tasks.length) return;
        for (const t of tasks) t.status = status; // optimistic; the file watcher confirms
        render();
        if (tasks.length === 1) mdpm.post({ type: 'setStatus', file: tasks[0].key, status });
        else mdpm.post({ type: 'setStatusMany', files: tasks.map((t) => t.key), status });
      });
    }
    for (const b of app.querySelectorAll('.col-add')) {
      b.addEventListener('click', () => mdpm.post({ type: 'newTask', project: mdpm.state.project || undefined, status: b.dataset.status }));
    }
    mdpm.paintSelection();
  }

  mdpm.render = render;
  mdpm.post({ type: 'ready' });
})();
