// Waterfall / Gantt timeline: bars from start to end, dependency arrows, drag to reschedule.
(() => {
  const app = document.getElementById('app');
  const ROW = 30;
  const LABEL = 300;
  const ZOOM = { day: 32, week: 14, month: 4 };
  const DAY_MS = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  if (!ZOOM[mdpm.state.zoom]) mdpm.state.zoom = 'week';

  /** Days since epoch for a YYYY-MM-DD string (UTC, so DST never shifts bars). */
  const dayNum = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS : undefined;
  };
  const fmt = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
  const utc = (n) => new Date(n * DAY_MS);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;

  /** [start, end] day numbers, or null when unscheduled. A single date makes a one-day bar. */
  const span = (t) => {
    const s = dayNum(t.start) ?? dayNum(t.end);
    const e = dayNum(t.end) ?? dayNum(t.start);
    return s === undefined ? null : [Math.min(s, e), Math.max(s, e)];
  };

  let scrolledToToday = false;
  let drag = null;
  let geom = null;

  function render() {
    const m = mdpm.model;
    mdpm.toolbar(
      `<span class="seg">${Object.keys(ZOOM)
        .map((z) => `<button class="zoom" data-zoom="${z}">${z[0].toUpperCase() + z.slice(1)}</button>`)
        .join('')}</span>
       <button id="b-today">Today</button>
       <button id="b-new" title="New task">＋ New task</button>`,
      () => {
        for (const b of document.querySelectorAll('.zoom')) b.addEventListener('click', () => {
          scrolledToToday = false;
          mdpm.set({ zoom: b.dataset.zoom });
        });
        document.getElementById('b-today').addEventListener('click', scrollToToday);
        document.getElementById('b-new').addEventListener('click', () => mdpm.post({ type: 'newTask', project: mdpm.state.project || undefined }));
      },
    );
    for (const b of document.querySelectorAll('.zoom')) b.classList.toggle('active', b.dataset.zoom === mdpm.state.zoom);

    if (!m.projects.length) {
      app.innerHTML = `<div class="empty">No projects found. Create a folder with a <code>.proj</code> file, or use “mdpm: New Project”.</div>`;
      return;
    }

    const tasks = mdpm.filtered();
    const px = ZOOM[mdpm.state.zoom];

    // Rows: each project that owns visible tasks, followed by its tasks (scheduled first, by start date).
    const rows = [];
    for (const p of m.projects) {
      const own = tasks.filter((t) => t.home === p.key);
      if (!own.length) continue;
      rows.push({ type: 'project', p });
      own
        .sort((a, b) => (span(a)?.[0] ?? Infinity) - (span(b)?.[0] ?? Infinity) || a.title.localeCompare(b.title))
        .forEach((t) => rows.push({ type: 'task', t, p }));
    }

    // Visible range: everything scheduled plus some padding, always including today; starts on a Monday.
    let min = today - 7;
    let max = today + 35;
    for (const t of tasks) {
      const sp = span(t);
      if (!sp) continue;
      min = Math.min(min, sp[0] - 7);
      max = Math.max(max, sp[1] + 14);
    }
    min -= (utc(min).getUTCDay() + 6) % 7;
    const days = max - min + 1;
    const width = days * px;
    geom = { min, px };

    const scroller = app.querySelector('.wf-scroll');
    const keep = scroller && { left: scroller.scrollLeft, top: scroller.scrollTop };

    const weekend = mdpm.state.zoom !== 'month'
      ? `background-image: linear-gradient(90deg, transparent ${5 * px}px, var(--weekend) ${5 * px}px); background-size: ${7 * px}px 100%;`
      : '';

    app.innerHTML = `
      <div class="wf-scroll">
        <div class="wf-inner" style="width:${LABEL + width}px; --label:${LABEL}px; --row:${ROW}px">
          <div class="wf-header">
            <div class="wf-corner">${tasks.length} tasks</div>
            <div class="wf-scale" style="width:${width}px">${scale(min, max, px)}</div>
          </div>
          <div class="wf-body">
            ${rows.map((r) => (r.type === 'project' ? projectRow(r.p, width) : taskRow(r.t, width, weekend, px, min))).join('')}
            ${overlay(rows, min, px, width)}
          </div>
          ${rows.length ? '' : `<div class="empty">No tasks match the current filters.</div>`}
        </div>
      </div>`;

    const s = app.querySelector('.wf-scroll');
    if (keep) {
      s.scrollLeft = keep.left;
      s.scrollTop = keep.top;
    }
    if (!scrolledToToday) {
      scrolledToToday = true;
      scrollToToday();
    }
    wire();
  }

  function scale(min, max, px) {
    let months = '';
    let ticks = '';
    for (let d = min; d <= max; d++) {
      const date = utc(d);
      if (d === min || date.getUTCDate() === 1) {
        const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / DAY_MS;
        const w = (Math.min(next, max + 1) - d) * px;
        months += `<div class="month" style="left:${(d - min) * px}px;width:${w}px">${w >= 70 ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}` : ''}</div>`;
      }
      const left = (d - min) * px;
      if (mdpm.state.zoom === 'day') {
        ticks += `<div class="tick${d === today ? ' now' : ''}" style="left:${left}px;width:${px}px">${date.getUTCDate()}</div>`;
      } else if (mdpm.state.zoom === 'week' && date.getUTCDay() === 1) {
        ticks += `<div class="tick" style="left:${left}px;width:${7 * px}px">${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}</div>`;
      }
    }
    return `<div class="months">${months}</div><div class="ticks">${ticks}</div>`;
  }

  function projectRow(p, width) {
    return `<div class="wf-row group">
      <div class="wf-label" style="padding-left:${8 + p.depth * 14}px">▾ ${esc(p.name)} <span class="muted">${esc(p.relPath)}</span></div>
      <div class="wf-track" style="width:${width}px"></div>
    </div>`;
  }

  function taskRow(t, width, weekend, px, min) {
    const sp = span(t);
    const done = mdpm.isDone(t);
    const depth = (mdpm.project(t.home)?.depth ?? 0) + 1;
    let bar = '';
    if (sp) {
      const late = !done && sp[1] < today;
      bar = `<div class="bar${done ? ' done' : ''}${late ? ' late' : ''}" data-key="${esc(t.key)}"
        style="left:${(sp[0] - min) * px}px;width:${(sp[1] - sp[0] + 1) * px}px;--accent:${mdpm.statusColor(t)}"
        title="${esc(`${t.title}\n${fmt(sp[0])} → ${fmt(sp[1])} · ${t.status}${t.owner ? ` · @${t.owner}` : ''}`)}">
        <div class="h h-start"></div><span>${esc(t.title)}</span><div class="h h-end"></div></div>`;
    }
    return `<div class="wf-row task">
      <div class="wf-label" data-key="${esc(t.key)}" style="padding-left:${8 + depth * 14}px" title="${esc(t.relPath)}">
        <span class="dot" style="background:${mdpm.statusColor(t)}"></span>
        <span class="title${done ? ' done' : ''}">${esc(t.title)}</span>
        ${t.owner ? `<span class="muted">@${esc(t.owner)}</span>` : ''}
      </div>
      <div class="wf-track${sp ? '' : ' unscheduled'}" data-key="${esc(t.key)}" style="width:${width}px;${weekend}"
        ${sp ? '' : 'title="Click a day to schedule this task"'}>${bar}</div>
    </div>`;
  }

  /** SVG layer with the today line and dependency arrows (red when a dependency ends after the dependent starts). */
  function overlay(rows, min, px, width) {
    const height = rows.length * ROW;
    const rowOf = new Map();
    rows.forEach((r, i) => r.type === 'task' && rowOf.set(r.t.id, { i, t: r.t }));
    let paths = '';
    for (const { i, t } of rowOf.values()) {
      const sp = span(t);
      if (!sp) continue;
      for (const dep of t.dependsOn) {
        const from = rowOf.get(dep);
        const fsp = from && span(from.t);
        if (!fsp) continue;
        const x1 = (fsp[1] - min + 1) * px;
        const y1 = from.i * ROW + ROW / 2;
        const x2 = (sp[0] - min) * px;
        const y2 = i * ROW + ROW / 2;
        const bad = fsp[1] >= sp[0];
        paths += `<path class="dep${bad ? ' bad' : ''}" marker-end="url(#${bad ? 'arrow-bad' : 'arrow'})" d="M${x1} ${y1} h6 V${y2} H${x2 - 2}"/>`;
      }
    }
    const tx = (today - min) * px + px / 2;
    return `<svg class="wf-overlay" width="${width}" height="${height}" style="left:${LABEL}px">
      <defs>
        <marker id="arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L6 3L0 6z" class="arrowhead"/></marker>
        <marker id="arrow-bad" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L6 3L0 6z" class="arrowhead bad"/></marker>
      </defs>
      <line class="today" x1="${tx}" x2="${tx}" y1="0" y2="${height}"/>
      ${paths}
    </svg>`;
  }

  function scrollToToday() {
    const s = app.querySelector('.wf-scroll');
    if (s && geom) s.scrollLeft = Math.max(0, (today - geom.min) * geom.px - (s.clientWidth - LABEL) / 3);
  }

  function wire() {
    for (const el of app.querySelectorAll('.wf-label[data-key]')) {
      el.addEventListener('click', () => mdpm.post({ type: 'open', file: el.dataset.key }));
    }
    for (const track of app.querySelectorAll('.wf-track.unscheduled')) {
      track.addEventListener('click', (e) => {
        const day = geom.min + Math.floor(e.offsetX / geom.px);
        const task = mdpm.model.tasks.find((t) => t.key === track.dataset.key);
        task.start = task.end = fmt(day);
        render();
        mdpm.post({ type: 'setDates', file: task.key, start: task.start, end: task.end });
      });
    }
    for (const bar of app.querySelectorAll('.bar')) bar.addEventListener('pointerdown', startDrag);
  }

  function startDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const bar = e.currentTarget;
    const task = mdpm.model.tasks.find((t) => t.key === bar.dataset.key);
    const [s, en] = span(task);
    const mode = e.target.classList.contains('h-start') ? 'start' : e.target.classList.contains('h-end') ? 'end' : 'move';
    drag = { bar, task, mode, x0: e.clientX, s, e: en, ns: s, ne: en, moved: false };
    bar.setPointerCapture(e.pointerId);
    bar.addEventListener('pointermove', onDrag);
    bar.addEventListener('pointerup', endDrag, { once: true });
  }

  function onDrag(e) {
    const d = drag;
    const delta = Math.round((e.clientX - d.x0) / geom.px);
    if (Math.abs(e.clientX - d.x0) > 3) d.moved = true;
    if (d.mode === 'move') [d.ns, d.ne] = [d.s + delta, d.e + delta];
    else if (d.mode === 'start') [d.ns, d.ne] = [Math.min(d.s + delta, d.e), d.e];
    else [d.ns, d.ne] = [d.s, Math.max(d.e + delta, d.s)];
    d.bar.style.left = `${(d.ns - geom.min) * geom.px}px`;
    d.bar.style.width = `${(d.ne - d.ns + 1) * geom.px}px`;
    d.bar.dataset.tip = `${fmt(d.ns)} → ${fmt(d.ne)}`;
    d.bar.classList.add('dragging');
  }

  function endDrag() {
    const d = drag;
    drag = null;
    d.bar.removeEventListener('pointermove', onDrag);
    if (!d.moved) return mdpm.post({ type: 'open', file: d.task.key });
    if (d.ns === d.s && d.ne === d.e) return render();
    d.task.start = fmt(d.ns);
    d.task.end = fmt(d.ne);
    render();
    mdpm.post({ type: 'setDates', file: d.task.key, start: d.task.start, end: d.task.end });
  }

  mdpm.render = render;
  mdpm.post({ type: 'ready' });
})();
