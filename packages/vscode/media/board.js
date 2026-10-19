// Kanban board: one column per status, drag cards to change status.
(() => {
  const app = document.getElementById('app');

  function card(t) {
    const focused = mdpm.state.project;
    const overdue = t.end && t.end < mdpm.today && !mdpm.isDone(t);
    const homeName = mdpm.project(t.home)?.name;
    const meta = [
      `<span class="id">${esc(t.id)}</span>`,
      t.priority !== undefined ? `<span class="badge prio">${esc(String(t.priority).match(/^\d/) ? `P${t.priority}` : t.priority)}</span>` : '',
      t.end ? `<span class="${overdue ? 'due overdue' : 'due'}" title="${esc(`${t.start ?? '?'} → ${t.end}`)}">⏱ ${esc(t.end)}</span>` : '',
      t.shared ? `<span class="shared" title="Shared with ${t.projects.length} projects">🔗${t.projects.length}</span>` : '',
      t.owner ? `<span class="owner" title="${esc(t.owner)}">${esc(t.owner)}</span>` : '',
    ].join('');
    return `
      <div class="card" draggable="true" data-key="${esc(t.key)}" title="${esc(t.relPath)}" style="--accent:${mdpm.statusColor(t)}">
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

    app.innerHTML = `<div class="board">${columns
      .map((status) => {
        const col = mdpm.sorted(tasks.filter((t) => t.status === status));
        return `
          <section class="column" data-status="${esc(status)}">
            <header><span class="col-name">${esc(status)}</span><span class="count">${col.length}</span>
              <button class="col-add" data-status="${esc(status)}" title="New task in “${esc(status)}”">＋</button></header>
            <div class="cards">${col.map(card).join('')}</div>
          </section>`;
      })
      .join('')}</div>`;
    wire();
  }

  function wire() {
    for (const el of app.querySelectorAll('.card')) {
      el.addEventListener('click', () => mdpm.post({ type: 'open', file: el.dataset.key }));
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', el.dataset.key);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
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
        const task = mdpm.model.tasks.find((t) => t.key === e.dataTransfer.getData('text/plain'));
        const status = col.dataset.status;
        if (!task || task.status === status) return;
        task.status = status; // optimistic; the file watcher confirms
        render();
        mdpm.post({ type: 'setStatus', file: task.key, status });
      });
    }
    for (const b of app.querySelectorAll('.col-add')) {
      b.addEventListener('click', () => mdpm.post({ type: 'newTask', project: mdpm.state.project || undefined, status: b.dataset.status }));
    }
  }

  mdpm.render = render;
  mdpm.post({ type: 'ready' });
})();
