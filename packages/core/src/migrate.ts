import { promises as fs } from 'fs';
import { isMap, parseDocument } from 'yaml';
import { agentNames } from './agent';
import { IDEA_HEADING, LOG_HEADING, QUESTIONS_HEADING, checkboxes, headings, planCheck, sectionText } from './body';
import { stringList } from './build';
import { splitFrontMatter, updateFrontMatter } from './frontmatter';
import { isStatus } from './flow';
import { slugify, today } from './ops';
import { BLOCKED_STATUS, OBSOLETE_PROJECT_FIELDS, OBSOLETE_TASK_FIELDS, Project, Workspace } from './types';

/*
 * `mdpm migrate`: a one-time rewrite of a task-based workspace into the flow. Statuses are mapped
 * (see the table in docs/agent-workflow.md), task-era fields and settings are removed, and body
 * sections are renamed. Planned first, so it can be shown as a dry run.
 */

/** Statuses of the task-based workflow (its defaults), used when a project defined none. */
const OLD_DEFAULT_STATUSES = ['backlog', 'todo', 'in-progress', 'blocked', 'review', 'done'];

/** The question the old runner blocked refined tasks on; in the flow that is a plan waiting for approval. */
const REFINEMENT_QUESTION = /^(\([^)]*\)\s*)?Review the refined description/;

export interface IdeaMigration {
  file: string;
  id: string;
  from: string;
  to: string;
  /** Front matter changes (`null` deletes a key). */
  changes: Record<string, unknown>;
  /** `## heading` renames in the body, [from, to]. */
  renames: [string, string][];
  /** Ticks the old "review the refinement" question, which approving the plan now answers. */
  tickRefinement?: boolean;
  /** What the person should know, e.g. dropped dependencies. */
  notes: string[];
}

export interface ProjectMigration {
  file: string;
  /** Dotted keys removed, e.g. `statuses`, `agent.modes`. */
  removed: string[];
}

export interface MigrationPlan {
  ideas: IdeaMigration[];
  projects: ProjectMigration[];
  /** Files that can't be migrated automatically, and what to do about them. */
  problems: { file: string; message: string }[];
}

export interface MigrateOptions {
  /** Whether a git branch exists, to record `agent/<id>` branches of executing ideas. */
  branchExists?: (branch: string) => boolean;
}

/** The statuses a project had in the task-based workflow (inherited from its parents). */
function oldStatuses(p: Project | undefined): string[] {
  for (let cur = p; cur; cur = cur.parent) {
    const s = stringList(cur.meta.statuses);
    if (s.length) return s;
  }
  return OLD_DEFAULT_STATUSES;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v instanceof Date ? v.toISOString().slice(0, 10) : undefined);

/** Works out every change `mdpm migrate --write` would make. Changes nothing. */
export function planMigration(ws: Workspace, opts: MigrateOptions = {}): MigrationPlan {
  const agents = agentNames(ws);
  const plan: MigrationPlan = { ideas: [], projects: [], problems: [] };

  for (const p of ws.projects) {
    const removed = OBSOLETE_PROJECT_FIELDS.filter((k) => p.meta[k] !== undefined);
    const agent = p.meta.agent;
    if (agent && typeof agent === 'object' && !Array.isArray(agent)) {
      for (const k of ['unassigned', 'modes']) if ((agent as Record<string, unknown>)[k] !== undefined) removed.push(`agent.${k}`);
    }
    if (removed.length) plan.projects.push({ file: p.file, removed });
  }

  // Ideas that would hold the execution slot; only the one started first keeps it.
  const slotCandidates: IdeaMigration[] = [];
  const started = new Map<IdeaMigration, string>();

  for (const t of ws.tasks) {
    const m = t.meta;
    const status = t.status;
    const statuses = oldStatuses(t.home);
    const owner = str(m.owner);
    const start = str(m.start);
    const end = str(m.end);
    const complete = planCheck(t.body).complete;
    const agentOwned = !!owner && agents.has(owner);
    const notes: string[] = [];
    const changes: Record<string, unknown> = {};
    for (const k of OBSOLETE_TASK_FIELDS) if (m[k] !== undefined) changes[k] = null;
    const deps = stringList(m.depends_on ?? m.dependsOn ?? m.depends);
    if (deps.length) notes.push(`dropped depends_on (${deps.join(', ')}); the order now comes from priority and approval`);

    let to: string | undefined;
    let tickRefinement = false;
    const final = status === statuses[statuses.length - 1] && status !== BLOCKED_STATUS;
    if (final || status === 'done') {
      to = 'done';
      if (!m.completed && end) changes.completed = end;
    } else if (['review', 'in-review'].includes(status)) {
      to = 'review';
    } else if (['in-progress', 'doing', 'building', 'executing'].includes(status)) {
      to = 'executing';
    } else if (status === BLOCKED_STATUS) {
      const open = checkboxes(sectionText(t.body, QUESTIONS_HEADING)).filter((c) => !c.checked);
      if (!start && complete && open.length && open.every((q) => REFINEMENT_QUESTION.test(q.text))) {
        // Blocked only so the person reviews a refinement: that is a plan waiting for approval now.
        to = 'plan';
        tickRefinement = true;
        changes.approved = null;
        notes.push('was blocked for you to review its refinement; it is now a plan waiting for your approval');
      } else {
        to = BLOCKED_STATUS;
        if (m.blocked_from === undefined) changes.blocked_from = start ? 'executing' : complete ? 'plan' : 'idea';
      }
    } else if (['todo', 'planned', 'ready'].includes(status)) {
      to = complete ? 'plan' : 'idea';
      if (complete && agentOwned) {
        changes.approved = today();
        notes.push(`was queued for ${owner}, so its plan is approved`);
      }
    } else if (status === 'backlog' || status === statuses[0]) {
      // Backlog was never refined or queued, whatever criteria it has: the agent plans it.
      to = 'idea';
    } else if (isStatus(status)) {
      to = status;
    }
    if (!to) {
      plan.problems.push({ file: t.file, message: `status "${status}" has no flow equivalent, so this idea was left as it is. Set "status:" to one of idea, plan, executing, review or done, then run mdpm migrate again.` });
      continue;
    }

    const mig: IdeaMigration = { file: t.file, id: t.id, from: status, to, changes, renames: renames(t.body), tickRefinement, notes };
    if (to !== status) changes.status = to;
    const holdsSlot = to === 'executing' || (to === BLOCKED_STATUS && (changes.blocked_from ?? m.blocked_from) === 'executing');
    if (holdsSlot) {
      slotCandidates.push(mig);
      started.set(mig, start ?? str(m.created) ?? '9999');
      if (!m.approved) changes.approved = today();
      const branch = str(m.branch) ?? (opts.branchExists?.(`agent/${slugify(t.id)}`) ? `agent/${slugify(t.id)}` : undefined);
      if (branch && !m.branch) changes.branch = branch;
    }
    if (Object.keys(changes).length || mig.renames.length || tickRefinement) plan.ideas.push(mig);
  }

  // One idea executes at a time: the one started first keeps the slot, the others go to the front of the plan queue.
  slotCandidates.sort((a, b) => started.get(a)!.localeCompare(started.get(b)!) || a.id.localeCompare(b.id));
  for (const mig of slotCandidates.slice(1)) {
    if (mig.to === 'executing') {
      mig.to = 'plan';
      mig.changes.status = 'plan';
    } else {
      mig.changes.blocked_from = 'plan';
    }
    mig.notes.push(`only one idea executes at a time and "${slotCandidates[0].id}" keeps the slot, so this one waits as an approved plan`);
  }
  return plan;
}

/** Body heading renames: `Agent log` → `Log`, and `Description` (or else `Goal`) → `Idea`. */
function renames(body: string): [string, string][] {
  const hs = headings(body);
  const out: [string, string][] = [];
  if (hs.includes('agent log') && !hs.includes(LOG_HEADING.toLowerCase())) out.push(['Agent log', LOG_HEADING]);
  if (!hs.includes(IDEA_HEADING.toLowerCase())) {
    if (hs.includes('description')) out.push(['Description', IDEA_HEADING]);
    else if (hs.includes('goal')) out.push(['Goal', IDEA_HEADING]);
  }
  return out;
}

/** Renames level-2 headings outside code blocks. */
function renameHeadings(body: string, pairs: [string, string][]): string {
  let fenced = false;
  return body
    .split(/(\r?\n)/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      const pair = m && pairs.find(([from]) => from.toLowerCase() === m[1].toLowerCase());
      return pair ? `## ${pair[1]}` : line;
    })
    .join('');
}

/** Ticks the old "review the refinement" question. */
function tickRefinementQuestion(body: string): string {
  return body.replace(/^(\s*[-*+]\s+)\[ \](\s*(?:\([^)]*\)\s*)?Review the refined description)/m, '$1[x]$2');
}

/** Applies a migration plan, idea files and `.proj` files alike. */
export async function applyMigration(plan: MigrationPlan): Promise<void> {
  for (const mig of plan.ideas) {
    let text = await fs.readFile(mig.file, 'utf8');
    if (Object.keys(mig.changes).length) text = updateFrontMatter(text, mig.changes);
    const split = splitFrontMatter(text);
    if (split && (mig.renames.length || mig.tickRefinement)) {
      let body = renameHeadings(split.body, mig.renames);
      if (mig.tickRefinement) body = tickRefinementQuestion(body);
      text = text.slice(0, text.length - split.body.length) + body;
    }
    await fs.writeFile(mig.file, text, 'utf8');
  }
  for (const p of plan.projects) {
    const doc = parseDocument(await fs.readFile(p.file, 'utf8'));
    for (const key of p.removed) doc.deleteIn(key.split('.'));
    const agent = doc.get('agent');
    if (isMap(agent) && agent.items.length === 0) doc.delete('agent');
    await fs.writeFile(p.file, doc.toString({ lineWidth: 0 }), 'utf8');
  }
}
