// AI flow board: Idea → Planned → Building → Review → Done. Each lane is a view over statuses
// (mapped in @mdpm/core flow.ts); dragging a card asks the extension for the lane's status.
(() => {
  const app = document.getElementById('app');
  const ACTORS = { you: 'You', agent: 'Agent' };

  const blocked = (t) => t.status === 'blocked';
  const needsYou = (t) => blocked(t) || t.stage === 'review';

  function progress(t) {
    const { done, total } = t.criteria;
    if (!total) return t.stage === 'idea' ? '' : `<span class="no-plan" title="No acceptance criteria yet, so an agent will plan it first">no plan yet</span>`;
    return `<span class="criteria" title="${done} of ${total} acceptance criteria met">
      <span class="bar"><span style="width:${Math.round((done / total) * 100)}%"></span></span>${done}/${total}</span>`;
  }

  function card(t) {
    const homeName = mdpm.project(t.home)?.name;
    const meta = [
      `<span class="id">${esc(t.id)}</span>`,
      mdpm.runBadge(t),
      progress(t),
      t.branch && t.stage === 'review' ? `<span class="branch" title="Branch to review">⎇ ${esc(t.branch)}</span>` : '',
      t.owner ? `<span class="owner" title="${esc(t.owner)}">${esc(t.owner)}</span>` : '',
    ].join('');
    return `
      <div class="card${blocked(t) ? ' blocked' : ''}${t.running ? ' working' : ''}" draggable="true" data-key="${esc(t.key)}" title="${esc(t.relPath)} · ${esc(t.status)}">
        ${blocked(t) ? `<div class="flag">Needs your answer</div>` : ''}
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-meta">${meta}</div>
        ${t.home !== mdpm.state.project && homeName ? `<div class="card-project">${esc(homeName)}</div>` : ''}
      </div>`;
  }

  function render() {
    const m = mdpm.model;
    const tasks = m.projects.length ? mdpm.filtered() : [];
    const waiting = tasks.filter(needsYou).length;
    mdpm.toolbar(`<span id="needs-you" class="needs-you"></span><button id="b-new" title="Write down something you want built">＋ New idea</button>`, () => {
      document.getElementById('b-new').addEventListener('click', () => newIdea());
    });
    const badge = document.getElementById('needs-you');
    badge.textContent = waiting ? `${waiting} waiting on you` : 'Nothing waiting on you';
    badge.classList.toggle('active', waiting > 0);

    if (!m.projects.length) {
      app.innerHTML = `<div class="empty">No projects found. Create a folder with a <code>.proj</code> file, or use “mdpm: New Project”.</div>`;
      return;
    }

    app.innerHTML = `<div class="board flow">${m.stages
      .map((s) => {
        const lane = mdpm.sorted(tasks.filter((t) => t.stage === s.stage));
        // Things waiting on a person float to the top of their lane.
        lane.sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)));
        return `
          <section class="column stage-${esc(s.stage)}" data-stage="${esc(s.stage)}">
            <header>
              <span class="col-name">${esc(s.label)}</span><span class="count">${lane.length}</span>
              <span class="actor actor-${esc(s.actor)}" title="Who moves work on from here">${ACTORS[s.actor]}</span>
              ${s.stage === 'idea' ? `<button class="col-add" title="New idea">＋</button>` : ''}
            </header>
            <div class="hint">${esc(s.hint)}</div>
            <div class="cards">${lane.map(card).join('') || (s.stage === 'idea' ? `<div class="lane-empty">Write an idea the way you'd prompt an agent.</div>` : '')}</div>
          </section>`;
      })
      .join('')}</div>`;
    wire();
  }

  function newIdea() {
    // New tasks start in the project's first status, which is the Idea lane.
    mdpm.post({ type: 'newTask', project: mdpm.state.project || undefined });
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
        const stage = col.dataset.stage;
        if (!task || task.stage === stage) return;
        task.stage = stage; // optimistic; the file watcher confirms
        render();
        mdpm.post({ type: 'setStage', file: task.key, stage });
      });
    }
    app.querySelector('.col-add')?.addEventListener('click', () => newIdea());
  }

  mdpm.render = render;
  mdpm.post({ type: 'ready' });
})();
