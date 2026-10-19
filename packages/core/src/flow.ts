import { Project, Task } from './types';

/**
 * Stages of the AI flow board: how work moves when an agent does the building.
 * Each stage is a view over one or more statuses, so tasks keep their normal statuses
 * and the classic Kanban board keeps working.
 */
export const FLOW_STAGES = ['idea', 'planned', 'building', 'review', 'done'] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];

export interface FlowStageInfo {
  stage: FlowStage;
  label: string;
  /** Who moves work out of this stage. */
  actor: 'you' | 'agent';
  hint: string;
  /** Statuses (by name) that belong to this stage, preferred first; the first one present is used for drops. */
  statuses: string[];
}

export const FLOW_STAGE_INFO: Record<FlowStage, FlowStageInfo> = {
  idea: { stage: 'idea', label: 'Idea', actor: 'you', hint: 'Write what you want built', statuses: ['backlog', 'idea'] },
  planned: { stage: 'planned', label: 'Planned', actor: 'agent', hint: 'The agent turns the idea into a plan', statuses: ['todo', 'planned', 'ready'] },
  building: { stage: 'building', label: 'Building', actor: 'agent', hint: 'The agent writes the code', statuses: ['in-progress', 'building', 'doing', 'blocked'] },
  review: { stage: 'review', label: 'Review', actor: 'you', hint: 'Check the work and accept it', statuses: ['review', 'in-review'] },
  done: { stage: 'done', label: 'Done', actor: 'you', hint: 'The idea is now product', statuses: ['done'] },
};

/** Status that means "waiting for a person to answer questions". */
export const BLOCKED_STATUS = 'blocked';

export interface CriteriaProgress {
  done: number;
  total: number;
}

/** Checkboxes under the body's `## Acceptance criteria` heading (empty `- [ ]` placeholders don't count). */
export function acceptanceCriteria(body: string): CriteriaProgress {
  const out = { done: 0, total: 0 };
  let inside = false;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      inside = /^acceptance criteria\b/i.test(heading[2].trim());
      continue;
    }
    const box = inside && /^\s*[-*+]\s+\[([ xX])\]\s*(\S.*)?$/.exec(line);
    if (box && box[2]) {
      out.total++;
      if (box[1] !== ' ') out.done++;
    }
  }
  return out;
}

/** True when the task has a plan an agent can implement: at least one acceptance criterion. */
export function hasPlan(task: Pick<Task, 'body'>): boolean {
  return acceptanceCriteria(task.body).total > 0;
}

/**
 * The flow stage a task is in, from its status and the statuses of its home project.
 * - Known status names map directly (see `FLOW_STAGE_INFO`); the project's final status is always `done`.
 * - `blocked` stays in the stage it was blocked from: `building` once work started (`start` is set),
 *   else `planned` if it has acceptance criteria, else `idea`.
 * - Unknown custom statuses: the first one is `idea`, any other is `building`.
 */
export function flowStage(task: Pick<Task, 'status' | 'start' | 'body'>, statuses: string[]): FlowStage {
  const status = task.status;
  if (statuses.length && status === statuses[statuses.length - 1]) return 'done';
  if (status === BLOCKED_STATUS) return task.start ? 'building' : hasPlan(task) ? 'planned' : 'idea';
  for (const stage of FLOW_STAGES) if (FLOW_STAGE_INFO[stage].statuses.includes(status)) return stage;
  return statuses.indexOf(status) <= 0 ? 'idea' : 'building';
}

/**
 * The status to give a task dropped on `stage`, or `undefined` when the project has no status for it.
 * `blocked` is never chosen: blocking is the agent's call (with questions), not a drag target.
 */
export function statusForStage(stage: FlowStage, statuses: string[]): string | undefined {
  if (!statuses.length) return undefined;
  if (stage === 'done') return statuses[statuses.length - 1];
  const named = FLOW_STAGE_INFO[stage].statuses.find((s) => s !== BLOCKED_STATUS && statuses.includes(s));
  if (named) return named;
  if (stage === 'idea') return statuses[0];
  return undefined;
}

/** True when the task is waiting on a person: blocked with questions, or ready for review. */
export function needsPerson(task: Pick<Task, 'status' | 'start' | 'body'>, project: Pick<Project, 'statuses'>): boolean {
  return task.status === BLOCKED_STATUS || flowStage(task, project.statuses) === 'review';
}
