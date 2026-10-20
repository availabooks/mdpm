import { AgentError, WriteBack, priorityRank } from './agent';
import { CRITERIA_HEADING, PlanCheck, checkboxes, logEntries, planCheck, sectionText, tickQuestions } from './body';
import { slugify, today } from './ops';
import { AgentMode, BLOCKABLE_STATUSES, BLOCKED_STATUS, BlockableStatus, STATUSES, Status, Task, Workspace } from './types';

/*
 * The AI flow: idea → plan → executing → review → done, plus blocked. Which idea the agent works
 * on next (`mdpm next`), the single execution slot, and the commands that move ideas along.
 * Design: docs/agent-workflow.md.
 */

/** Columns of the flow board, in order. A blocked idea shows in the column it was blocked from. */
export const FLOW_STAGES = ['idea', 'plan', 'executing', 'review', 'done'] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];

export interface FlowStageInfo {
  stage: FlowStage;
  label: string;
  /** Who moves work out of this stage. */
  actor: 'you' | 'agent';
  hint: string;
}

export const FLOW_STAGE_INFO: Record<FlowStage, FlowStageInfo> = {
  idea: { stage: 'idea', label: 'Idea', actor: 'agent', hint: 'Write what you want; the agent plans it' },
  plan: { stage: 'plan', label: 'Plan', actor: 'you', hint: 'Approve a plan to queue it for execution' },
  executing: { stage: 'executing', label: 'Executing', actor: 'agent', hint: 'The agent builds one idea at a time' },
  review: { stage: 'review', label: 'Review', actor: 'you', hint: 'Check the work: accept it or send it back' },
  done: { stage: 'done', label: 'Done', actor: 'you', hint: 'Accepted' },
};

export function isStatus(s: string | undefined): s is Status {
  return (STATUSES as readonly string[]).includes(s ?? '');
}

export function isBlockable(s: string | undefined): s is BlockableStatus {
  return (BLOCKABLE_STATUSES as readonly string[]).includes(s ?? '');
}

/** The board column of an idea: its status, or for a blocked idea the status it was blocked from. */
export function flowStage(task: Pick<Task, 'status' | 'blockedFrom'>): FlowStage {
  if (task.status === BLOCKED_STATUS) return isBlockable(task.blockedFrom) ? task.blockedFrom : 'idea';
  return (FLOW_STAGES as readonly string[]).includes(task.status) ? (task.status as FlowStage) : 'idea';
}

export interface CriteriaProgress {
  done: number;
  total: number;
}

/** Checked and total checkboxes under `## Acceptance criteria` (empty `- [ ]` placeholders don't count). */
export function acceptanceCriteria(body: string): CriteriaProgress {
  const boxes = checkboxes(sectionText(body, CRITERIA_HEADING));
  return { done: boxes.filter((b) => b.checked).length, total: boxes.length };
}

/** A plan the person approved, waiting in the execution queue. */
export function isApproved(task: Pick<Task, 'status' | 'approved'>): boolean {
  return task.status === 'plan' && !!task.approved;
}

/** True when the idea holds the execution slot: executing, or blocked while executing. */
export function inSlot(task: Pick<Task, 'status' | 'blockedFrom'>): boolean {
  return task.status === 'executing' || (task.status === BLOCKED_STATUS && task.blockedFrom === 'executing');
}

/** The idea holding the execution slot, if any (more than one is a validation error). */
export function slotHolder(ws: Workspace): Task | undefined {
  return ws.tasks.find(inSlot);
}

/** True when the idea is waiting on a person: blocked, a plan to approve, or work to review. */
export function needsPerson(task: Pick<Task, 'status' | 'approved'>): boolean {
  return task.status === BLOCKED_STATUS || task.status === 'review' || (task.status === 'plan' && !task.approved);
}

/** "an idea", "a plan waiting for approval", "executing"…: where an idea is, for messages. */
export function describeStatus(task: Pick<Task, 'status' | 'approved' | 'blockedFrom'>): string {
  switch (task.status) {
    case 'idea':
      return 'an idea';
    case 'plan':
      return task.approved ? 'an approved plan' : 'a plan waiting for approval';
    case 'executing':
      return 'executing';
    case BLOCKED_STATUS:
      return `blocked (from ${task.blockedFrom ?? 'idea'})`;
    case 'review':
      return 'in review';
    case 'done':
      return 'done';
    default:
      return `"${task.status}"`;
  }
}

/** Why another idea can't start executing while `holder` has the slot, and what frees it. */
export function slotTakenMessage(holder: Task): string {
  const what =
    holder.status === BLOCKED_STATUS
      ? `"${holder.id}" is blocked on your answer and keeps the execution slot until it is finished. Answer it (mdpm unblock ${holder.id} "<answer>")`
      : `"${holder.id}" is executing. Let it finish`;
  return `only one idea executes at a time, and ${what}, or move it back to the plan queue with "mdpm move ${holder.id} plan".`;
}

export interface FlowPick {
  task: Task;
  mode: AgentMode;
  /** Continue an execution that an earlier run started. */
  resume: boolean;
  plan: PlanCheck;
}

export interface FlowSkip {
  task: Task;
  /** Why the agent won't work on it now, phrased so the person knows what to do. */
  reason: string;
}

export interface FlowQueue {
  /** What the agent can work on, best first: the execution in the slot, approved plans, then ideas to plan. */
  picks: FlowPick[];
  skipped: FlowSkip[];
  /** The idea holding the execution slot. */
  slot?: Task;
}

const byText = (a: string | undefined, b: string | undefined) => (a ?? '9999').localeCompare(b ?? '9999');

/** Approved plans in execution order: sent back from review first, then priority, then approval date. */
export function planQueueOrder(a: Task, b: Task): number {
  return Number(!!b.branch) - Number(!!a.branch) || priorityRank(a.priority) - priorityRank(b.priority) || byText(a.approved, b.approved) || byText(a.created, b.created) || a.id.localeCompare(b.id);
}

/** Ideas in planning order: priority, then oldest first. */
export function ideaQueueOrder(a: Task, b: Task): number {
  return priorityRank(a.priority) - priorityRank(b.priority) || byText(a.created, b.created) || a.id.localeCompare(b.id);
}

/** Everything the agent could work on, in order, and why the rest waits. */
export function flowQueue(ws: Workspace, opts: { exclude?: Set<string> } = {}): FlowQueue {
  const errorFiles = new Set(ws.issues.filter((i) => i.level === 'error').map((i) => i.file));
  const slot = slotHolder(ws);
  const skipped: FlowSkip[] = [];
  const eligible = (t: Task) => {
    if (opts.exclude?.has(t.id)) return false;
    if (!t.home.agent.enabled) {
      skipped.push({ task: t, reason: `agents are disabled in project "${t.home.name}" (agent.enabled: false). Set it to true in its .proj to let agents work there.` });
      return false;
    }
    if (errorFiles.has(t.file)) {
      skipped.push({ task: t, reason: 'it has validation errors. Run "mdpm check" and fix them.' });
      return false;
    }
    return true;
  };
  const pick = (task: Task, mode: AgentMode, resume = false): FlowPick => ({ task, mode, resume, plan: planCheck(task.body) });

  const resumes = ws.tasks.filter((t) => t.status === 'executing').filter(eligible).map((t) => pick(t, 'execute', true));

  const approved = ws.tasks.filter(isApproved).sort(planQueueOrder);
  const executions: FlowPick[] = [];
  approved.forEach((t, i) => {
    if (slot) skipped.push({ task: t, reason: `approved, #${i + 1} in the execution queue. It waits for the slot: ${slotTakenMessage(slot)}` });
    else if (eligible(t)) executions.push(pick(t, 'execute'));
  });

  const ideas = ws.tasks.filter((t) => t.status === 'idea').sort(ideaQueueOrder).filter(eligible).map((t) => pick(t, 'plan'));

  for (const t of ws.tasks) {
    if (t.status === 'plan' && !t.approved) skipped.push({ task: t, reason: `its plan waits for your approval. Read it, then run "mdpm approve ${t.id}" (or edit it, or move it back to idea to have it re-planned).` });
    if (t.status === BLOCKED_STATUS) skipped.push({ task: t, reason: `it is blocked on your answer. Answer its questions, then run "mdpm unblock ${t.id} \\"<answer>\\"".` });
  }
  return { picks: [...resumes, ...executions, ...ideas], skipped, slot };
}

/** How the agent would work on this idea right now, or why it can't (for `mdpm agent run --idea`). */
export function modeFor(ws: Workspace, task: Task): { mode: AgentMode; resume: boolean } | { reason: string } {
  if (task.status === 'executing') return { mode: 'execute', resume: true };
  if (task.status === 'idea') return { mode: 'plan', resume: false };
  if (isApproved(task)) {
    const holder = slotHolder(ws);
    return holder && holder !== task ? { reason: slotTakenMessage(holder) } : { mode: 'execute', resume: false };
  }
  if (task.status === 'plan') return { reason: `its plan waits for your approval. Run "mdpm approve ${task.id}" first, or move it back to idea to have it re-planned.` };
  if (task.status === BLOCKED_STATUS) return { reason: `it is blocked on your answer. Run "mdpm unblock ${task.id} \\"<answer>\\"" first.` };
  return { reason: `it is ${describeStatus(task)}; the agent only plans ideas and executes approved plans.` };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function refuse(task: Task, what: string, fix: string): never {
  throw new AgentError(`"${task.id}" is ${describeStatus(task)}, so it can't be ${what}. ${fix}`);
}

/** `mdpm propose`: the agent wrote a plan for an idea; it now waits for the person's approval. */
export function planPropose(task: Task, by: string, summary = ''): WriteBack {
  if (task.status !== 'idea' && !(task.status === 'plan' && !task.approved)) {
    refuse(task, 'proposed', task.status === BLOCKED_STATUS ? `Wait for the answer (mdpm unblock ${task.id}).` : 'Only ideas (and plans still waiting for approval) can be proposed.');
  }
  const check = planCheck(task.body);
  if (!check.complete) throw new AgentError(`the plan for "${task.id}" isn't complete: add ${check.missing} to the idea file, then run mdpm propose ${task.id} again.`);
  return { changes: { status: 'plan', approved: null }, log: summary.trim() ? `planned: ${summary.trim()}` : 'planned; waiting for approval', by };
}

/** `mdpm approve`: the person accepts the plan; it joins the execution queue. */
export function planApprove(task: Task, by: string): WriteBack {
  if (isApproved(task)) throw new AgentError(`"${task.id}" is already approved and waiting for execution. Nothing to do.`);
  if (task.status !== 'idea' && task.status !== 'plan') refuse(task, 'approved', 'Only plans (and ideas that already have a complete plan) can be approved.');
  const check = planCheck(task.body);
  if (!check.complete) {
    throw new AgentError(`"${task.id}" has no complete plan yet: it needs ${check.missing}. Let the agent plan it (mdpm agent run --idea ${task.id}), or write the acceptance criteria yourself, then approve it.`);
  }
  return { changes: { status: 'plan', approved: today() }, log: 'approved the plan', by };
}

/** `mdpm start`: an approved plan takes the execution slot, on its own branch. */
export function planStart(ws: Workspace, task: Task, by: string, run = ''): WriteBack {
  const tag = run ? ` (run ${run})` : '';
  if (task.status === 'executing') return { changes: {}, log: `resumed${tag}`, by };
  if (!isApproved(task)) {
    const fix =
      task.status === 'plan'
        ? `Approve it first: mdpm approve ${task.id}.`
        : task.status === 'idea'
          ? `Plan it first (mdpm agent run --idea ${task.id}), then approve the plan.`
          : task.status === BLOCKED_STATUS
            ? `Answer its questions first: mdpm unblock ${task.id} "<answer>".`
            : task.status === 'review'
              ? `To work on it again, send it back: mdpm rework ${task.id} "<feedback>".`
              : 'Only approved plans start executing.';
    refuse(task, 'started', fix);
  }
  const holder = ws.tasks.find((t) => t !== task && inSlot(t));
  if (holder) throw new AgentError(`"${task.id}" can't start: ${slotTakenMessage(holder)}`);
  const branch = task.branch ?? ideaBranch(task);
  return { changes: { status: 'executing', branch }, log: `started executing on branch ${branch}${tag}`, by };
}

/** The branch an idea is built on: `idea/<id>`. */
export function ideaBranch(task: Pick<Task, 'id'>): string {
  return `idea/${slugify(task.id) || 'idea'}`;
}

/** `mdpm block`: the idea can't move without answers; it returns to where it was when unblocked. */
export function planBlock(task: Task, by: string, questions: string[]): WriteBack {
  const asked = questions.map((q) => q.trim()).filter(Boolean);
  if (!asked.length) throw new AgentError('give at least one question, e.g. mdpm block <idea> "Should the export include archived ideas?"');
  const n = plural(asked.length, 'question');
  if (task.status === BLOCKED_STATUS) return { changes: {}, questions: asked, log: `asked ${n} more (see Questions)`, by };
  if (!isBlockable(task.status)) refuse(task, 'blocked', 'Only ideas, plans and executing ideas can be blocked.');
  return { changes: { status: BLOCKED_STATUS, blocked_from: task.status }, questions: asked, log: `blocked on ${n} (see Questions)`, by };
}

/** `mdpm unblock`: the person answered; the idea goes back to where it was blocked from. */
export function planUnblock(ws: Workspace, task: Task, by: string, answer = ''): WriteBack {
  if (task.status !== BLOCKED_STATUS) throw new AgentError(`"${task.id}" is ${describeStatus(task)}, not blocked, so there is nothing to unblock.`);
  const to: BlockableStatus = isBlockable(task.blockedFrom) ? task.blockedFrom : 'idea';
  if (to === 'executing') {
    const holder = ws.tasks.find((t) => t !== task && t.status === 'executing');
    if (holder) throw new AgentError(`"${task.id}" can't go back to executing: "${holder.id}" took the slot meanwhile. Move one of them back with "mdpm move <id> plan".`);
  }
  const text = answer.trim();
  return {
    changes: { status: to, blocked_from: null },
    body: tickQuestions,
    log: text ? `answered: ${text}\nback to ${to}` : `unblocked; back to ${to}`,
    by,
  };
}

/** `mdpm handoff`: the work is done and waits for the person's review. */
export function planHandoff(task: Task, by: string, summary: string, opts: { branch?: string; pr?: string } = {}): WriteBack {
  if (!summary.trim()) throw new AgentError('give a summary of what was done and how it was verified, e.g. mdpm handoff <idea> "Added CSV export; npm test passes"');
  if (task.status !== 'executing') refuse(task, 'handed off', `Only an executing idea is handed off.${isApproved(task) ? ` Start it first: mdpm start ${task.id}.` : ''}`);
  const changes: Record<string, unknown> = { status: 'review' };
  if (opts.branch) changes.branch = opts.branch;
  if (opts.pr) changes.pr = opts.pr;
  return { changes, log: `handed off for review: ${summary.trim()}`, by };
}

/** `mdpm rework`: the person sends reviewed work back; it goes to the front of the execution queue. */
export function planRework(task: Task, by: string, feedback: string): WriteBack {
  if (!feedback.trim()) throw new AgentError('say what needs to change, e.g. mdpm rework <idea> "The export misses archived ideas"');
  if (task.status !== 'review') refuse(task, 'sent back for rework', 'Only ideas in review can be sent back.');
  return { changes: { status: 'plan', approved: task.approved ?? today() }, log: `sent back for rework: ${feedback.trim()}`, by };
}

/** `mdpm accept`: the person accepts the reviewed work. */
export function planAccept(task: Task, by: string): WriteBack {
  if (task.status !== 'review') refuse(task, 'accepted', task.status === 'done' ? 'It is already done.' : 'Only ideas in review can be accepted; use "mdpm move <idea> done" to close one directly.');
  return { changes: { status: 'done', completed: today() }, log: 'accepted', by };
}

/**
 * `mdpm move`: the person's escape hatch, moving an idea to any status. The fields that go with
 * each status are kept consistent (approval, blocked_from, branch, completed), and the slot rule
 * still holds.
 */
export function planMove(ws: Workspace, task: Task, to: string, by: string): WriteBack {
  if (!isStatus(to)) {
    const hint = STATUSES.find((s) => s.startsWith(to.toLowerCase().slice(0, 3)));
    throw new AgentError(`"${to}" is not a status.${hint ? ` Did you mean "${hint}"?` : ''} The statuses are ${STATUSES.join(', ')}.`);
  }
  if (to === task.status) return { changes: {}, by };
  if (to === BLOCKED_STATUS) throw new AgentError(`use mdpm block ${task.id} "<question>" to block an idea, so it says what it is waiting for.`);
  const changes: Record<string, unknown> = { status: to };
  if (task.status === BLOCKED_STATUS) changes.blocked_from = null;
  if (task.status === 'done') changes.completed = null;
  if (to === 'idea') changes.approved = null;
  if (to === 'executing') {
    const holder = ws.tasks.find((t) => t !== task && inSlot(t));
    if (holder) throw new AgentError(`"${task.id}" can't start executing: ${slotTakenMessage(holder)}`);
    if (!task.approved) changes.approved = today();
    if (!task.branch) changes.branch = ideaBranch(task);
  }
  if (to === 'done') changes.completed = today();
  return { changes, log: `moved from ${task.status} to ${to}`, by };
}

/** What dropping an idea on a board column means: the flow command it runs, or why the move isn't one a person makes. */
export type DropIntent = { action: 'approve' | 'replan' | 'start' | 'rework' | 'accept' | 'move' } | { reason: string };

/** The board's drag rules: only the moves a person makes in the flow. */
export function dropIntent(task: Pick<Task, 'id' | 'status' | 'approved' | 'blockedFrom' | 'body'>, to: FlowStage): DropIntent {
  const from = flowStage(task);
  if (from === to) return { reason: '' };
  if (task.status === BLOCKED_STATUS) return { reason: `"${task.id}" is blocked on your answer. Answer its questions and unblock it first; it then returns to ${from}.` };
  if (from === 'idea' && to === 'plan') {
    return planCheck(task.body).complete ? { action: 'approve' } : { reason: `"${task.id}" has no plan yet. The agent plans it on its next run (or use Plan now); you approve the plan after that.` };
  }
  if (from === 'plan' && to === 'idea') return { action: 'replan' };
  if (from === 'plan' && to === 'executing') return task.approved ? { action: 'start' } : { reason: `Approve the plan of "${task.id}" first; approved plans are executed one at a time, in order.` };
  if (from === 'executing' && to === 'plan') return { action: 'move' };
  if (from === 'review' && to === 'done') return { action: 'accept' };
  if (from === 'review' && to === 'plan') return { action: 'rework' };
  if (from === 'done' && to === 'review') return { action: 'move' };
  const hints: Partial<Record<FlowStage, string>> = {
    executing: 'Ideas start executing from an approved plan, one at a time.',
    review: 'The agent hands work off to review when it is done.',
    done: 'Accept it from review once you have checked the work.',
    idea: 'Only a plan can be sent back to be re-planned.',
    plan: 'Plans come from ideas (the agent plans them) or from review (Rework).',
  };
  return { reason: `"${task.id}" can't move from ${FLOW_STAGE_INFO[from].label} to ${FLOW_STAGE_INFO[to].label}. ${hints[to] ?? ''}`.trim() };
}

/** Commands only a person may run; refused while `MDPM_AGENT` is set. */
export const PERSON_COMMANDS = ['approve', 'unblock', 'rework', 'accept', 'move', 'set'] as const;

/**
 * Guard rails while `MDPM_AGENT` is set: agents don't approve, accept or move ideas, and only
 * change the idea their run is about (`$MDPM_TASK`). Returns why a command is refused.
 */
export function agentGuard(command: string, task: Task, agent: string, runTask?: string): string | undefined {
  if ((PERSON_COMMANDS as readonly string[]).includes(command)) {
    return `"mdpm ${command}" is the person's call, not ${agent}'s. Finish with mdpm propose (a plan), mdpm handoff (finished work) or mdpm block (a question). If you are a person, unset MDPM_AGENT.`;
  }
  if (runTask && task.id !== runTask) {
    return `this run is about "${runTask}", so ${agent} can't change "${task.id}". Mention it in the log instead: mdpm log ${runTask} "<note>".`;
  }
  return undefined;
}

/**
 * For the Stop hook: true when the agent's last log entry on the idea is the run starting, i.e.
 * it is about to stop without proposing, handing off, blocking or logging progress.
 */
export function lastEntryIsStart(task: Task, agent: string): boolean {
  const last = logEntries(task.body).at(-1);
  return !!last && last.by === agent && /^(started|resumed)\b/i.test(last.text);
}
