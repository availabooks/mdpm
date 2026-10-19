import { Task } from '@mdpm/core';
import * as vscode from 'vscode';
import { Model } from './model';

/** Statuses every task's home project allows, in the first task's order. */
export function commonStatuses(tasks: Task[]): string[] {
  return tasks.reduce((acc, t) => acc.filter((s) => t.home.statuses.includes(s)), tasks[0]?.home.statuses ?? []);
}

/** One task per file, so a task selected in two projects (linked) is changed once. */
export function uniqueTasks(tasks: Task[]): Task[] {
  return [...new Map(tasks.map((t) => [t.file, t])).values()];
}

/** Asks for a status (unless given) and sets it on all `tasks`. */
export async function setStatus(model: Model, tasks: Task[], status?: string): Promise<void> {
  tasks = uniqueTasks(tasks);
  if (!tasks.length) return;
  if (tasks.length === 1 && !status) {
    const task = tasks[0];
    const pick = await vscode.window.showQuickPick(
      task.home.statuses.map((s) => ({ label: s, description: s === task.status ? 'current' : undefined })),
      { placeHolder: `Status for "${task.title}"` },
    );
    if (!pick || pick.label === task.status) return;
    status = pick.label;
  }
  if (!status) {
    const common = commonStatuses(tasks);
    if (!common.length) {
      const projects = [...new Set(tasks.map((t) => t.home))];
      vscode.window.showErrorMessage(
        `mdpm: the ${tasks.length} selected tasks are in projects with no status in common (` +
          projects.map((p) => `${p.name}: ${p.statuses.join(', ')}`).join('; ') +
          '), so no status can be set on all of them. Narrow the selection to tasks from projects that share statuses, then try again.',
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      common.map((s) => {
        const n = tasks.filter((t) => t.status === s).length;
        return { label: s, description: n ? `current for ${n}` : undefined };
      }),
      { placeHolder: `Status for ${tasks.length} tasks` },
    );
    if (!pick) return;
    status = pick.label;
  }
  const changing = tasks.filter((t) => t.status !== status);
  if (changing.length) await model.updateMany(changing.map((task) => ({ task, changes: { status } })));
}

/** Asks for an owner (unless given; empty unassigns) and sets it on all `tasks`. */
export async function setOwner(model: Model, tasks: Task[], owner?: string): Promise<void> {
  tasks = uniqueTasks(tasks);
  if (!tasks.length) return;
  if (owner === undefined) {
    const owners = [...new Set(tasks.map((t) => t.owner ?? ''))];
    owner = await vscode.window.showInputBox({
      prompt: tasks.length === 1 ? `Owner of "${tasks[0].title}" (empty to unassign)` : `Owner of ${tasks.length} tasks (empty to unassign)`,
      value: owners.length === 1 ? owners[0] : '',
    });
    if (owner === undefined) return;
  }
  const value = owner.trim() || null;
  const changing = tasks.filter((t) => (t.owner ?? null) !== value);
  if (changing.length) await model.updateMany(changing.map((task) => ({ task, changes: { owner: value } })));
}
