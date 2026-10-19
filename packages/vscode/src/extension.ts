import {
  BLOCKED_STATUS,
  Project,
  QUESTIONS_HEADING,
  TaskTemplate,
  Task,
  createProject,
  createTask,
  defaultAuthor,
  isFinalStatus,
  linkTask,
  modeFor,
  newTaskMeta,
  nextTaskPath,
  previewNewTask,
  slugify,
  taskBody,
  today,
  unlinkTask,
} from '@mdpm/core';
import * as path from 'path';
import * as vscode from 'vscode';
import { setOwner, setStatus } from './bulk';
import { Model } from './model';
import { ViewPanel } from './panel';
import { Node, ProjectTree } from './tree';

/** Arguments a command may receive: a tree node, a webview request, a file (editor title), or nothing (palette). */
type CommandArg = Node | { projectKey?: string; status?: string } | { taskFile: string } | vscode.Uri | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const model = new Model();
  const tree = new ProjectTree(model);
  context.subscriptions.push(model, vscode.window.createTreeView('mdpm.projects', { treeDataProvider: tree, canSelectMany: true }));

  const projectOf = (arg: CommandArg): Project | undefined => {
    if (arg instanceof vscode.Uri) return undefined;
    if (arg && 'kind' in arg) return arg.kind === 'project' ? arg.project : arg.location.project;
    if (arg && 'projectKey' in arg && arg.projectKey) return model.project(arg.projectKey);
    return undefined;
  };

  /** The task a command targets: tree node, else the task open in the active editor. */
  const taskOf = (arg: CommandArg): Task | undefined => {
    if (arg instanceof vscode.Uri) return model.task(arg.fsPath);
    if (arg && 'taskFile' in arg) return model.task(arg.taskFile);
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

  /** Runs `mdpm agent run --task <id>` with the bundled CLI in a terminal, so the run is visible and can be stopped. */
  const sendToAgent = async (task: Task, agent: string) => {
    const ws = model.workspaceOf(task);
    if (!ws) return;
    if (!modeFor(task)) {
      const hint = task.status === BLOCKED_STATUS ? ' Answer its questions and use "Unblock" first.' : ' Move it back to todo first if it needs more work.';
      vscode.window.showWarningMessage(`mdpm: "${task.title}" is ${task.status}; agents only work on backlog, todo and in-progress tasks.${hint}`);
      return;
    }
    const cli = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mdpm.js').fsPath;
    const terminal = vscode.window.createTerminal({
      name: `mdpm · ${agent} · ${task.id}`,
      // VS Code's own runtime acts as node, so nothing has to be installed or on PATH; no shell is involved.
      shellPath: process.execPath,
      shellArgs: [cli, '--root', ws.root, 'agent', 'run', '--task', task.id, '--agent', agent],
      cwd: ws.root,
      env: { ELECTRON_RUN_AS_NODE: '1', MDPM_AGENT: null },
      iconPath: new vscode.ThemeIcon('hubot'),
    });
    terminal.show();
  };

  const pickAgent = async (placeHolder: string): Promise<string | undefined> => {
    const agents = model.agents();
    const def = model.defaultAgent();
    const items = agents.map((a) => ({ label: `$(hubot) ${a}`, description: a === def ? 'default (mdpm.agent.default)' : undefined, agent: a }));
    return (await vscode.window.showQuickPick(items, { placeHolder }))?.agent;
  };

  /** Keeps the editor title buttons in step with the task in the active editor. */
  const updateContext = () => {
    const doc = vscode.window.activeTextEditor?.document;
    const task = doc ? model.task(doc.uri.fsPath) : undefined;
    vscode.commands.executeCommand('setContext', 'mdpm.activeTask', !!task);
    vscode.commands.executeCommand('setContext', 'mdpm.activeTaskBlocked', !!task && model.isBlocked(task));
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateContext), model.onDidChange(updateContext));


  /**
   * The tasks a command targets: every task selected in the tree when the clicked node is
   * part of a multi-selection (project nodes are ignored), else the single task.
   */
  const requireTasks = (arg: CommandArg, selected?: Node[]): Task[] => {
    const id = (n: Node) => (n.kind === 'project' ? n.project.file : n.location.path);
    const clicked = arg && 'kind' in arg ? id(arg) : undefined;
    if (clicked && selected && selected.length > 1 && selected.some((n) => id(n) === clicked)) {
      const tasks = selected.flatMap((n) => (n.kind === 'task' ? [n.task] : []));
      if (tasks.length) return tasks;
    }
    const task = requireTask(arg);
    return task ? [task] : [];
  };

  const run = (fn: (arg: CommandArg, selected?: Node[]) => Promise<unknown>) => async (arg: CommandArg, selected?: unknown) => {
    try {
      await fn(arg, Array.isArray(selected) ? selected : undefined);
    } catch (e) {
      vscode.window.showErrorMessage(`mdpm: ${e instanceof Error ? e.message : e}`);
    }
  };

  const commands: Record<string, (arg: CommandArg, selected?: Node[]) => Promise<unknown>> = {
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
      const template = vscode.workspace.getConfiguration('mdpm').get<TaskTemplate>('taskTemplate') === 'default' ? 'default' : 'agent';
      const task = { title: title.trim(), status, owner, author: defaultAuthor(project.dir), end, body: taskBody(title.trim(), template) };
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

    'mdpm.setStatus': async (arg, selected) => setStatus(model, requireTasks(arg, selected)),

    'mdpm.setOwner': async (arg, selected) => setOwner(model, requireTasks(arg, selected)),

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

    'mdpm.sendToAgent': async (arg) => {
      const task = requireTask(arg);
      if (task) await sendToAgent(task, model.defaultAgent());
    },

    'mdpm.sendToAgentAs': async (arg) => {
      const task = requireTask(arg);
      if (!task) return;
      const agent = await pickAgent(`Send "${task.title}" to…`);
      if (agent) await sendToAgent(task, agent);
    },

    'mdpm.queueForAgent': async (arg) => {
      const task = requireTask(arg);
      if (!task) return;
      const agent = await pickAgent(`Queue "${task.title}" for… (the next "mdpm agent run" picks it up)`);
      if (!agent || agent === task.owner) return;
      await model.update(task, { owner: agent }, { text: `queued for ${agent}`, by: defaultAuthor(task.home.dir) });
    },

    'mdpm.unblock': async (arg) => {
      const task = requireTask(arg);
      if (!task) return;
      if (!model.isBlocked(task)) {
        vscode.window.showInformationMessage(`mdpm: "${task.title}" is ${task.status}, not blocked, so there is nothing to unblock.`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(task.file);
      const line = doc.getText().split(/\r?\n/).findIndex((l) => new RegExp(`^##\\s+${QUESTIONS_HEADING}\\s*$`, 'i').test(l));
      const at = new vscode.Position(Math.max(0, line), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at), preview: false });
      const target = task.home.statuses.includes('todo') ? 'todo' : task.home.statuses[0];
      const saved = await model.update(task, { status: target }, { text: `unblocked; moved back to ${target}`, by: defaultAuthor(task.home.dir) });
      if (saved) {
        vscode.window.showInformationMessage(
          `mdpm: "${task.title}" is back in ${target}. Answer the questions inline (tick them or write below them); ${task.owner ?? 'the agent'} reads them on its next run.`,
        );
      }
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
  updateContext();
}

export function deactivate() {}

function depth(p: Project): number {
  return p.parent ? depth(p.parent) + 1 : 0;
}

function rootOf(p: Project): string {
  return p.parent ? rootOf(p.parent) : path.dirname(p.dir);
}
