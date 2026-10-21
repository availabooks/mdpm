// The flow board: Idea → Plan → Executing → Review → Done. Card buttons run the flow commands;
// dropping a card on another column asks the extension, which only allows the moves a person makes.
(() => {
  const app = document.getElementById('app');
  const ACTORS = { you: 'You', agent: 'Agent' };

  const blocked = (t) => t.status === BLOCKED;

  function progress(t) {
    const { done, total } = t.criteria;
    if (!total) return t.stage === 'idea' ? '' : `<span class="no-plan" title="No acceptance criteria yet">no criteria</span>`;
    return `<span class="criteria" title="${done} of ${total} acceptance criteria met">
      <span class="bar"><span style="width:${Math.round((done / total) * 100)}%"></span></span>${done}/${total}</span>`;
  }

  /** Where the idea stands, when that needs saying. */
  function flag(t) {
    if (blocked(t)) return `<div class="flag ask">Needs your answer${t.questions > 1 ? ` (${t.questions})` : ''}</div>`;
    if (t.status === 'plan' && !t.approved) return `<div class="flag you">Awaiting your approval</div>`;
    if (t.status === 'plan') return `<div class="flag queued">Approved · #${t.queue} in queue${t.branch ? ' · rework' : ''}</div>`;
    if (t.status === 'review') return `<div class="flag you">Ready for your review</div>`;
    return '';
  }

  const btn = (action, label, title, primary = false) => `<button class="act${primary ? '' : ' more'}" data-action="${action}" title="${esc(title)}">${label}</button>`;

  /** The buttons for what can happen to the idea next. */
  function actions(t) {
    if (t.running) return '';
    const agent = mdpm.model.defaultAgent;
    if (blocked(t)) return btn('unblock', 'Answer', 'Open the questions, answer them, and unblock', true);
    switch (t.status) {
      case 'idea':
        return btn('planNow', '▶ Plan now', `Have ${agent} plan this idea now (in a terminal)`, true);
      case 'plan':
        return (t.approved ? '' : btn('approve', '✓ Approve', 'Approve the plan: it joins the execution queue', true)) + btn('replan', '↺', 'Send it back to be planned again');
      case 'executing':
        return btn('continue', '💬', `Talk to ${agent} about this idea, in its worktree`);
      case 'review':
        return btn('accept', '✓ Accept', 'Accept the work: done', true) + btn('rework', '↩', 'Send it back with feedback; it is executed next') + (t.pr ? btn('openPr', 'PR', 'Open the pull request') : '');
      default:
        return '';
    }
  }

  function card(t) {
    const homeName = mdpm.project(t.home)?.name;
    const meta = [
      `<span class="id">${esc(t.id)}</span>`,
      mdpm.runBadge(t),
      progress(t),
      t.branch && ['executing', 'review'].includes(t.stage) ? `<span class="branch" title="Branch with the work">⎇ ${esc(t.branch)}</span>` : '',
      t.priority !== undefined ? `<span class="badge prio">${esc(String(t.priority).match(/^\d/) ? `P${t.priority}` : t.priority)}</span>` : '',
    ].join('');
    const acts = actions(t);
    return `
      <div class="card${blocked(t) ? ' blocked' : ''}${t.needsYou ? ' needs' : ''}${t.running ? ' working' : ''}" draggable="true" data-key="${esc(t.key)}" title="${esc(t.relPath)} · ${esc(t.status)}">
        ${acts ? `<div class="card-actions">${acts}</div>` : ''}
        ${flag(t)}
        <div class="card-title">${esc(t.title)}</div>
        <div class="card-meta">${meta}</div>
        ${t.home !== mdpm.state.project && homeName ? `<div class="card-project">${esc(homeName)}</div>` : ''}
      </div>`;
  }

  /** "Executing: export-csv · claude 12m", "Slot free · 3 approved plans waiting". */
  function slotText(m, tasks) {
    const run = m.tasks.find((t) => t.running);
    if (m.slot) {
      const s = m.tasks.find((t) => t.key === m.slot.key);
      if (m.slot.status === BLOCKED) return `<span class="slot blocked" title="It keeps the slot until you answer">⚠ Slot: ${esc(m.slot.id)} is blocked on you</span>`;
      return `<span class="slot busy">⚙ Executing: ${esc(m.slot.id)}${s?.running ? ` · ${esc(s.running.agent)} <span class="age" data-since="${esc(s.running.started)}">${mdpm.ago(s.running.started)}</span>` : ''}</span>`;
    }
    const approved = tasks.filter((t) => t.approved).length;
    const planning = run && run.running.mode === 'plan' ? ` · planning ${esc(run.id)}` : '';
    return `<span class="slot free">Slot free · ${approved ? `${approved} approved plan${approved > 1 ? 's' : ''} waiting` : 'no approved plans'}${planning}</span>`;
  }

  function render() {
    const m = mdpm.model;
    const tasks = m.projects.length ? mdpm.filtered() : [];
    const waiting = tasks.filter((t) => t.needsYou).length;
    mdpm.toolbar(
      `<span id="slot"></span><span id="needs-you" class="needs-you"></span><button id="b-run" title="Run the agent once on what is next in the flow">▶ Run next</button><button id="b-new" title="Write down something you want built">＋ New idea</button>`,
      () => {
        document.getElementById('b-new').addEventListener('click', () => mdpm.post({ type: 'newIdea', project: mdpm.state.project || undefined }));
        document.getElementById('b-run').addEventListener('click', () => mdpm.post({ type: 'action', action: 'runNext' }));
      },
    );
    document.getElementById('slot').innerHTML = slotText(m, tasks);
    const badge = document.getElementById('needs-you');
    badge.textContent = waiting ? `Waiting on you: ${waiting}` : 'Nothing waiting on you';
    badge.classList.toggle('active', waiting > 0);
    const run = document.getElementById('b-run');
    run.disabled = !m.next || m.tasks.some((t) => t.running);
    run.title = m.tasks.some((t) => t.running)
      ? 'The agent is already working; one run at a time'
      : m.next
        ? `Run the agent once: ${m.next.mode === 'plan' ? 'plan' : m.next.resume ? 'continue' : 'execute'} "${m.next.id}"`
        : 'Nothing for the agent to do: everything waits on you';

    if (!m.projects.length) {
      app.innerHTML = `<div class="empty">No projects found. Create a folder with a <code>.proj</code> file, or use “mdpm: New Project”.</div>`;
      return;
    }

    app.innerHTML = `<div class="board flow">${m.stages
      .map((s) => {
        const lane = mdpm.sorted(tasks.filter((t) => t.stage === s.stage));
        // What waits on the person floats to the top; approved plans follow in queue order.
        lane.sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || (a.queue ?? 0) - (b.queue ?? 0));
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

  function wire() {
    for (const b of app.querySelectorAll('.card .act')) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        mdpm.post({ type: 'action', action: b.dataset.action, file: b.closest('.card').dataset.key });
      });
    }
    for (const el of app.querySelectorAll('.card')) {
      el.addEventListener('click', (e) => mdpm.clickTask(e, el.dataset.key));
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
        // The extension decides what the move means (approve, accept, rework…) or says why it isn't one.
        mdpm.post({ type: 'drop', file: task.key, stage });
      });
    }
    app.querySelector('.col-add')?.addEventListener('click', () => mdpm.post({ type: 'newIdea', project: mdpm.state.project || undefined }));
    mdpm.paintSelection();
  }

  mdpm.render = render;
  mdpm.post({ type: 'ready' });
})();
