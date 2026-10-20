import {
  AgentError,
  FlowStage,
  QUESTIONS_HEADING,
  Task,
  WriteBack,
  defaultAuthor,
  dropIntent,
  openQuestions,
  planAccept,
  planApprove,
  planMove,
  planRework,
  planStart,
  planUnblock,
} from '@mdpm/core';
import * as vscode from 'vscode';
import { Model } from './model';

/*
 * The person's side of the flow, shared by the board, the tree and the editor: approve, start,
 * unblock, rework, accept, re-plan, and what a drag between columns means.
 */

/** One idea per file, so an idea selected in two projects (linked) is changed once. */
export function uniqueTasks(tasks: Task[]): Task[] {
  return [...new Map(tasks.map((t) => [t.file, t])).values()];
}

const by = (t: Task) => defaultAuthor(t.home.dir);

/** Plans a write-back per idea; refusals (wrong status, slot taken…) are collected, not thrown. */
function planEach(tasks: Task[], fn: (t: Task) => WriteBack): { items: { task: Task; wb: WriteBack }[]; refused: string[] } {
  const items: { task: Task; wb: WriteBack }[] = [];
  const refused: string[] = [];
  for (const task of uniqueTasks(tasks)) {
    try {
      items.push({ task, wb: fn(task) });
    } catch (e) {
      if (!(e instanceof AgentError)) throw e;
      refused.push(e.message);
    }
  }
  return { items, refused };
}

async function run(model: Model, tasks: Task[], fn: (t: Task) => WriteBack): Promise<Task[]> {
  const { items, refused } = planEach(tasks, fn);
  if (refused.length) vscode.window.showErrorMessage(`mdpm: ${refused.join(' ')}`);
  return items.length ? model.apply(items) : [];
}

/** Approves plans; they join the execution queue. */
export async function approve(model: Model, tasks: Task[]): Promise<void> {
  const open = uniqueTasks(tasks).filter((t) => openQuestions(t.body).length);
  if (open.length) {
    const go = await vscode.window.showWarningMessage(
      `mdpm: ${open.map((t) => `"${t.title}"`).join(', ')} still ${open.length > 1 ? 'have' : 'has'} open questions. The agent reads them as they are; answer them in the file first if they matter.`,
      { modal: true },
      'Approve Anyway',
    );
    if (go !== 'Approve Anyway') return;
  }
  const done = await run(model, tasks, (t) => planApprove(t, by(t)));
  if (done.length) vscode.window.setStatusBarMessage(`mdpm: approved ${done.length === 1 ? `"${done[0].title}"` : `${done.length} plans`}; ${done.length === 1 ? 'it is' : 'they are'} in the execution queue`, 5000);
}

/** Accepts reviewed work. */
export async function accept(model: Model, tasks: Task[]): Promise<void> {
  await run(model, tasks, (t) => planAccept(t, by(t)));
}

/** Takes the execution slot for an approved plan (without running the agent). */
export async function start(model: Model, task: Task): Promise<void> {
  const ws = model.workspaceOf(task);
  if (ws) await run(model, [task], (t) => planStart(ws, t, by(t)));
}

/** Sends reviewed work back with feedback; it is executed next, on the same branch. */
export async function rework(model: Model, task: Task): Promise<void> {
  const feedback = await vscode.window.showInputBox({
    prompt: `What should change in "${task.title}"? The agent reads this before it continues on ${task.branch ?? 'its branch'}.`,
    placeHolder: 'e.g. The export misses archived ideas',
    ignoreFocusOut: true,
  });
  if (!feedback?.trim()) return;
  await run(model, [task], (t) => planRework(t, by(t), feedback));
}

/** Opens the questions, asks for the answer, and sends the idea back to where it was blocked from. */
export async function unblock(model: Model, task: Task): Promise<void> {
  const ws = model.workspaceOf(task);
  if (!ws) return;
  if (!model.isBlocked(task)) {
    vscode.window.showInformationMessage(`mdpm: "${task.title}" is ${task.status}, not blocked, so there is nothing to unblock.`);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(task.file);
  const line = doc.getText().split(/\r?\n/).findIndex((l) => new RegExp(`^##\\s+${QUESTIONS_HEADING}\\s*$`, 'i').test(l));
  const at = new vscode.Position(Math.max(0, line), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at), preview: false });
  const questions = openQuestions(task.body);
  const answer = await vscode.window.showInputBox({
    prompt: questions.length ? `Answer: ${questions.join(' · ')}` : `Unblock "${task.title}"`,
    placeHolder: 'Your answer (or leave empty if you answered in the file)',
    ignoreFocusOut: true,
  });
  if (answer === undefined) return;
  if (doc.isDirty) await doc.save();
  const fresh = model.task(task.file) ?? task;
  await run(model, [fresh], (t) => planUnblock(ws, t, by(t), answer));
}

/** Sends a plan back to be planned again, with what should change. */
export async function replan(model: Model, task: Task): Promise<void> {
  const ws = model.workspaceOf(task);
  if (!ws) return;
  const why = await vscode.window.showInputBox({
    prompt: `What should the agent change when it plans "${task.title}" again? (optional)`,
    placeHolder: 'e.g. Keep it to the CLI; no VS Code changes',
    ignoreFocusOut: true,
  });
  if (why === undefined) return;
  await run(model, [task], (t) => {
    const wb = planMove(ws, t, 'idea', by(t));
    return { ...wb, log: why.trim() ? `sent back to be re-planned: ${why.trim()}` : 'sent back to be re-planned' };
  });
}

/** Moves an idea back out of the execution slot, to the front of the plan queue. */
export async function pause(model: Model, task: Task): Promise<void> {
  const ws = model.workspaceOf(task);
  if (!ws) return;
  const ok = await vscode.window.showWarningMessage(
    `Move "${task.title}" out of the execution slot, back to the plan queue? Its branch is kept, and it is executed first when the slot is free.`,
    { modal: true },
    'Move Back',
  );
  if (ok) await run(model, [task], (t) => planMove(ws, t, 'plan', by(t)));
}

/** What a drop of `task` on the `stage` column does: the matching flow command, or why not. */
export async function drop(model: Model, task: Task, stage: FlowStage): Promise<void> {
  const intent = dropIntent(task, stage);
  if ('reason' in intent) {
    if (intent.reason) vscode.window.showInformationMessage(`mdpm: ${intent.reason}`);
    model.reload(); // puts the card back
    return;
  }
  const ws = model.workspaceOf(task);
  if (!ws) return;
  switch (intent.action) {
    case 'approve':
      return approve(model, [task]);
    case 'replan':
      return replan(model, task);
    case 'start':
      return start(model, task);
    case 'rework':
      return rework(model, task);
    case 'accept':
      return accept(model, [task]);
    case 'move':
      if (task.status === 'executing') return pause(model, task);
      await run(model, [task], (t) => planMove(ws, t, stage, by(t)));
  }
}
