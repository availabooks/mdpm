import { Project, Task, createProject, createTask, defaultAuthor, isFinalStatus, linkTask, newTaskMeta, nextTaskPath, previewNewTask, slugify, today, unlinkTask } from '@mdpm/core';
import * as path from 'path';
import * as vscode from 'vscode';
import { Model } from './model';
import { ViewPanel } from './panel';
import { Node, ProjectTree } from './tree';

/** Arguments a command may receive: a tree node, a webview request, or nothing (palette). */
type CommandArg = Node | { projectKey?: string; status?: string } | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const model = new Model();
  const tree = new ProjectTree(model);
  context.subscriptions.push(model, vscode.window.registerTreeDataProvider('mdpm.projects', tree));

  const projectOf = (arg: CommandArg): Project | undefined => {
    if (arg && 'kind' in arg) return arg.kind === 'project' ? arg.project : arg.location.project;
    if (arg && 'projectKey' in arg && arg.projectKey) return model.project(arg.projectKey);
    return undefined;
  };

  /** The task a command targets: tree node, else the task open in the active editor. */
  const taskOf = (arg: CommandArg): Task | undefined => {
    if (arg && 'kind' in arg && arg.kind === 'task') return arg.task;
    const doc = vscode.window.activeTextEditor?.document;
    return doc ? model.task(doc.uri.fsPath) : undefined;
  };

  const pickProject = async (placeHolder: string, exclude: Project[] = []): Promise<Project | undefined> => {
    const items = model.projects
      .filter((p) => !exclude.includes(p))
      .map((p) => ({ label: `${'    '.repeat(depth(p))}${p.name}`, description: path.relative(rootOf(p), p.dir) || '.', project: p }));
    if (items.length === 1 && !exclude.length) return items[0].project;
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.project;
  };

  const requireTask = (arg: CommandArg): Task | undefined => {
    const task = taskOf(arg);
    if (!task) {
      vscode.window.showWarningMessage(
        'mdpm: no task selected. Right-click a task in the mdpm Projects view, or open a task file in the editor, then run this command again.',
      );
    }
    return task;
  };

  const run = (fn: (arg: CommandArg) => Promise<unknown>) => async (arg: CommandArg) => {
    try {
      await fn(arg);
    } catch (e) {
      vscode.window.showErrorMessage(`mdpm: ${e instanceof Error ? e.message : e}`);
    }
  };

  const commands: Record<string, (arg: CommandArg) => Promise<unknown>> = {
    'mdpm.refresh': () => model.reload(),

    'mdpm.openBoard': async (arg) => ViewPanel.show('board', context.extensionUri, model, projectOf(arg)?.file),

    'mdpm.openFlow': async (arg) => ViewPanel.show('flow', context.extensionUri, model, projectOf(arg)?.file),

    'mdpm.openWaterfall': async (arg) => ViewPanel.show('waterfall', context.extensionUri, model, projectOf(arg)?.file),

    'mdpm.newTask': async (arg) => {
      if (!model.projects.length) {
        const create = await vscode.window.showInformationMessage(
          'mdpm: there are no projects yet, so there is nowhere to put the task. A project is any folder containing a .proj file; create one first.',
          'Create Project',
        );
        if (create) await vscode.commands.executeCommand('mdpm.newProject');
        return;
      }
      const project = projectOf(arg) ?? (await pickProject('Project for the new task'));
      if (!project) return;
      const title = await vscode.window.showInputBox({ prompt: `New task in ${project.name}`, placeHolder: 'Task title' });
      if (!title?.trim()) return;
      const status = arg && 'status' in arg && arg.status ? arg.status : project.statuses[0];
      const owner = vscode.workspace.getConfiguration('mdpm').get<string>('defaultOwner') || undefined;
      const end = isFinalStatus(project, status) ? today() : undefined;
      const task = { title: title.trim(), status, owner, author: defaultAuthor(project.dir), end };
      const ws = model.workspaces.find((w) => w.projects.includes(project));
      const errors = ws
        ? previewNewTask(ws, project, nextTaskPath(project.dir, task.title, project.taskExtension), newTaskMeta(task)).filter((i) => i.level === 'error')
        : [];
      if (errors.length) {
        const choice = await vscode.window.showErrorMessage(
          `mdpm: a task "${task.title}" in ${project.name} would be invalid, so it was not created.`,
          { modal: true, detail: errors.map((i) => `• ${i.message}`).join('\n') + '\n\nYou can create it anyway and fix the front matter afterwards.' },
          'Create Anyway',
        );
        if (choice !== 'Create Anyway') return;
      }
      const file = await createTask(project.dir, task, project.taskExtension);
      await model.reload();
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    },

    'mdpm.newProject': async (arg) => {
      let parent = projectOf(arg);
      if (!parent && model.projects.length) {
        const choice = await vscode.window.showQuickPick(
          [{ label: '$(root-folder) New top-level project', project: undefined as Project | undefined }, ...model.projects.map((p) => ({ label: `${'    '.repeat(depth(p))}${p.name}`, project: p as Project | undefined }))],
          { placeHolder: 'Create the project inside…' },
        );
        if (!choice) return;
        parent = choice.project;
      }
      const name = await vscode.window.showInputBox({ prompt: parent ? `New sub project of ${parent.name}` : 'New project name', placeHolder: 'Project name' });
      if (!name?.trim()) return;

      let dir: string;
      if (parent) {
        dir = path.join(parent.dir, slugify(name) || 'project');
      } else {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
          const open = await vscode.window.showErrorMessage(
            'mdpm: no folder is open, so there is nowhere to create the project. Open the folder or repository you want to keep tasks in, then run "mdpm: New Project" again.',
            'Open Folder…',
          );
          if (open) await vscode.commands.executeCommand('workbench.action.files.openFolder');
          return;
        }
        const sub = vscode.workspace.getConfiguration('mdpm').get<string>('root') || '';
        const rel = await vscode.window.showInputBox({
          prompt: 'Folder for the project, relative to the workspace',
          value: model.projects.length ? path.join(sub, slugify(name)) : sub || 'tasks',
        });
        if (rel === undefined) return;
        dir = path.join(folder.uri.fsPath, rel);
      }
      const file = await createProject(dir, { name: name.trim(), description: '', owner: defaultAuthor(parent?.dir) });
      await model.reload();
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    },

    'mdpm.setStatus': async (arg) => {
      const task = requireTask(arg);
      if (!task) return;
      const status = await vscode.window.showQuickPick(
        task.home.statuses.map((s) => ({ label: s, description: s === task.status ? 'current' : undefined })),
        { placeHolder: `Status for "${task.title}"` },
      );
      if (!status || status.label === task.status) return;
      await model.update(task, { status: status.label });
    },

    'mdpm.setOwner': async (arg) => {
      const task = requireTask(arg);
      if (!task) return;
      const owner = await vscode.window.showInputBox({ prompt: `Owner of "${task.title}" (empty to unassign)`, value: task.owner ?? '' });
      if (owner === undefined) return;
      await model.update(task, { owner: owner.trim() || null });
    },

    'mdpm.linkTask': async (arg) => {
      const task = requireTask(arg);
      if (!task) return;
      const target = await pickProject(`Also show "${task.title}" in…`, task.locations.map((l) => l.project));
      if (!target) return;
      const link = await linkTask(task.file, target.dir);
      await model.reload();
      if (link.kind === 'stub') {
        const help = await vscode.window.showWarningMessage(
          'mdpm: the task was linked, but this machine does not allow symlinks, so a small text file holding the path was written instead. ' +
            'mdpm treats it the same way. To get real symlinks, enable Windows Developer Mode and run "git config core.symlinks true".',
          'How to Enable Developer Mode',
        );
        if (help) {
          await vscode.env.openExternal(vscode.Uri.parse('https://learn.microsoft.com/windows/apps/get-started/enable-your-device-for-development'));
        }
      }
    },

    'mdpm.unlinkTask': async (arg) => {
      if (!arg || !('kind' in arg) || arg.kind !== 'task' || !arg.location.link) return;
      const ok = await vscode.window.showWarningMessage(
        `Remove "${arg.task.title}" from ${arg.location.project.name}? The task itself stays in ${arg.task.home.name}.`,
        { modal: true },
        'Remove',
      );
      if (!ok) return;
      await unlinkTask(arg.location.path);
      await model.reload();
    },

    'mdpm.openProjectFile': async (arg) => {
      const p = projectOf(arg);
      if (p) await vscode.window.showTextDocument(vscode.Uri.file(p.file));
    },

    'mdpm.revealInExplorer': async (arg) => {
      if (!arg || !('kind' in arg)) return;
      const target = arg.kind === 'project' ? arg.project.dir : arg.location.path;
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(target));
    },
  };

  for (const [id, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(id, run(fn)));

  await model.reload();
}

export function deactivate() {}

function depth(p: Project): number {
  return p.parent ? depth(p.parent) + 1 : 0;
}

function rootOf(p: Project): string {
  return p.parent ? rootOf(p.parent) : path.dirname(p.dir);
}
