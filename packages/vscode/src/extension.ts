import {
  Project,
  Task,
  Workspace,
  activityVerb,
  ago,
  createProject,
  createTask,
  defaultAuthor,
  ideaBody,
  isApproved,
  linkTask,
  modeFor,
  newTaskMeta,
  nextTaskPath,
  previewNewTask,
  slotHolder,
  slugify,
  unlinkTask,
} from '@mdpm/core';
import * as path from 'path';
import * as vscode from 'vscode';
import * as flow from './flow';
import { Model } from './model';
import { BoardPanel } from './panel';
import { Node, ProjectTree } from './tree';

/** Arguments a command may receive: a tree node, a webview request, a file (editor title), or nothing (palette). */
type CommandArg = Node | { projectKey?: string } | { taskFile: string } | vscode.Uri | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const model = new Model();
  const tree = new ProjectTree(model);
  context.subscriptions.push(model, vscode.window.createTreeView('mdpm.projects', { treeDataProvider: tree, canSelectMany: true }));

  const projectOf = (arg: CommandArg): Project | undefined => {
    if (arg instanceof vscode.Uri) return undefined;
    if (arg && 'kind' in arg) return arg.kind === 'task' ? arg.location.project : arg.project;
    if (arg && 'projectKey' in arg && arg.projectKey) return model.project(arg.projectKey);
    return undefined;
  };

  /** The idea a command targets: tree node, else the idea open in the active editor. */
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
      vscode.window.showWarningMessage('mdpm: no idea selected. Right-click an idea in the mdpm Projects view, or open an idea file in the editor, then run this command again.');
    }
    return task;
  };

  /**
   * The ideas a command targets: every idea selected in the tree when the clicked node is part
   * of a multi-selection (other nodes are ignored), else the single idea.
   */
  const requireTasks = (arg: CommandArg, selected?: Node[]): Task[] => {
    const id = (n: Node) => (n.kind === 'task' ? n.location.path : n.kind === 'stage' ? `${n.project.file}#${n.stage}` : n.project.file);
    const clicked = arg && 'kind' in arg ? id(arg) : undefined;
    if (clicked && selected && selected.length > 1 && selected.some((n) => id(n) === clicked)) {
      const tasks = selected.flatMap((n) => (n.kind === 'task' ? [n.task] : []));
      if (tasks.length) return tasks;
    }
    const task = requireTask(arg);
    return task ? [task] : [];
  };

  /** Runs the bundled CLI in a terminal (no shell, nothing on PATH needed), so a run is visible and can be stopped. */
  const cliTerminal = (ws: Workspace, name: string, icon: string, args: string[]) => {
    const cli = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mdpm.js').fsPath;
    const terminal = vscode.window.createTerminal({
      name,
      // VS Code's own runtime acts as node, so nothing has to be installed or on PATH; no shell is involved.
      shellPath: process.execPath,
      shellArgs: [cli, '--root', ws.root, ...args],
      cwd: ws.root,
      env: { ELECTRON_RUN_AS_NODE: '1', MDPM_AGENT: null },
      iconPath: new vscode.ThemeIcon(icon),
    });
    terminal.show();
  };

  /** Refuses to start a second run: one at a time per workspace. */
  const busy = (): boolean => {
    const r = model.active[0];
    if (!r) return false;
    vscode.window.showWarningMessage(`mdpm: ${r.agent} is ${activityVerb(r.mode)} "${r.task}" (started ${ago(r.started)} ago), and only one run happens at a time. Wait for it to finish, or stop its terminal first.`);
    return true;
  };

  /** Plans an idea now, or executes it if it is the approved plan whose turn it is. */
  const planNow = async (task: Task) => {
    const ws = model.workspaceOf(task);
    if (!ws || busy()) return;
    const how = modeFor(ws, task);
    if ('reason' in how) {
      vscode.window.showWarningMessage(`mdpm: the agent can't work on "${task.title}" now: ${how.reason}`);
      return;
    }
    const agent = model.defaultAgent();
    cliTerminal(ws, `mdpm · ${agent} · ${task.id}`, 'hubot', ['agent', 'run', '--idea', task.id, '--agent', agent]);
  };

  /** Runs the agent on whatever is next in the flow (`--until-idle` keeps going). */
  const runNext = async (untilIdle: boolean) => {
    if (busy()) return;
    const ws =
      model.workspaces.length === 1
        ? model.workspaces[0]
        : (await vscode.window.showQuickPick(model.workspaces.map((w) => ({ label: path.basename(w.root), description: w.root, ws: w })), { placeHolder: 'Run the agent in…' }))?.ws;
    if (!ws) return;
    const agent = model.defaultAgent();
    cliTerminal(ws, `mdpm · ${agent} · flow`, 'hubot', ['agent', 'run', '--agent', agent, ...(untilIdle ? ['--until-idle'] : [])]);
  };

  /**
   * Opens a terminal talking to the agent about an idea: `mdpm agent continue` reopens its last run
   * on the idea (or starts a conversation from the idea) in the agent worktree, on the idea's branch.
   * Interactive, so permission prompts come to you.
   */
  const continueWithAgent = async (task: Task) => {
    const ws = model.workspaceOf(task);
    if (!ws || busy()) return;
    cliTerminal(ws, `mdpm · chat · ${task.id}`, 'comment-discussion', ['agent', 'continue', task.id]);
  };

  // Status bar: what the agent is doing, else what holds the execution slot.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'mdpm.openBoard';
  context.subscriptions.push(status);
  const updateStatus = () => {
    const run = model.active[0];
    const slot = model.workspaces.map(slotHolder).find(Boolean);
    const waiting = model.toDTO().tasks.filter((t) => t.needsYou).length;
    if (!run && !slot && !waiting) return status.hide();
    status.text = run ? `$(sync~spin) ${run.agent} ${activityVerb(run.mode)} ${run.task}` : slot ? `$(gear) ${slot.status === 'blocked' ? '⚠ ' : ''}${slot.id}` : '$(lightbulb) mdpm';
    if (waiting) status.text += ` · ${waiting} waiting on you`;
    status.tooltip = new vscode.MarkdownString(
      [
        run ? `**${run.agent}** is ${activityVerb(run.mode)} **${run.task}** · ${ago(run.started)}` : 'No agent is working right now.',
        slot ? `Execution slot: **${slot.id}** (${slot.status})` : 'Execution slot: free',
        waiting ? `${waiting} waiting on you` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    status.show();
  };
  context.subscriptions.push(model.onDidChange(updateStatus));

  /** Keeps the editor title buttons in step with the idea in the active editor. */
  const updateContext = () => {
    const doc = vscode.window.activeTextEditor?.document;
    const task = doc ? model.task(doc.uri.fsPath) : undefined;
    vscode.commands.executeCommand('setContext', 'mdpm.activeTask', !!task);
    vscode.commands.executeCommand('setContext', 'mdpm.activeTaskState', task ? (isApproved(task) ? 'plan-approved' : task.status) : '');
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateContext), model.onDidChange(updateContext));

  const run = (fn: (arg: CommandArg, selected?: Node[]) => Promise<unknown>) => async (arg: CommandArg, selected?: unknown) => {
    try {
      await fn(arg, Array.isArray(selected) ? selected : undefined);
    } catch (e) {
      vscode.window.showErrorMessage(`mdpm: ${e instanceof Error ? e.message : e}`);
    }
  };

  const one = (fn: (task: Task) => Promise<unknown>) => async (arg: CommandArg) => {
    const task = requireTask(arg);
    if (task) await fn(task);
  };

  const commands: Record<string, (arg: CommandArg, selected?: Node[]) => Promise<unknown>> = {
    'mdpm.refresh': () => model.reload(),

    'mdpm.openBoard': async (arg) => BoardPanel.show(context.extensionUri, model, projectOf(arg)?.file),

    'mdpm.newIdea': async (arg) => {
      if (!model.projects.length) {
        const create = await vscode.window.showInformationMessage(
          'mdpm: there are no projects yet, so there is nowhere to put the idea. A project is any folder containing a .proj file; create one first.',
          'Create Project',
        );
        if (create) await vscode.commands.executeCommand('mdpm.newProject');
        return;
      }
      const project = projectOf(arg) ?? (await pickProject('Project for the new idea'));
      if (!project) return;
      const title = await vscode.window.showInputBox({ prompt: `New idea in ${project.name}`, placeHolder: 'What do you want built? (a short title)' });
      if (!title?.trim()) return;
      const task = { title: title.trim(), status: 'idea', author: defaultAuthor(project.dir), body: ideaBody(title.trim()) };
      const ws = model.workspaces.find((w) => w.projects.includes(project));
      const errors = ws ? previewNewTask(ws, project, nextTaskPath(project.dir, task.title, project.taskExtension), newTaskMeta(task)).filter((i) => i.level === 'error') : [];
      if (errors.length) {
        const choice = await vscode.window.showErrorMessage(
          `mdpm: an idea "${task.title}" in ${project.name} would be invalid, so it was not created.`,
          { modal: true, detail: errors.map((i) => `• ${i.message}`).join('\n') + '\n\nYou can create it anyway and fix the front matter afterwards.' },
          'Create Anyway',
        );
        if (choice !== 'Create Anyway') return;
      }
      const file = await createTask(project.dir, task, project.taskExtension);
      await model.reload();
      // Put the cursor under "## Idea", where the person writes.
      const doc = await vscode.workspace.openTextDocument(file);
      const line = doc.getText().split(/\r?\n/).findIndex((l) => /^##\s+Idea\s*$/i.test(l));
      const at = new vscode.Position(Math.max(0, line + 2), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at) });
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
            'mdpm: no folder is open, so there is nowhere to create the project. Open the folder or repository you want to keep ideas in, then run "mdpm: New Project" again.',
            'Open Folder…',
          );
          if (open) await vscode.commands.executeCommand('workbench.action.files.openFolder');
          return;
        }
        const sub = vscode.workspace.getConfiguration('mdpm').get<string>('root') || '';
        const rel = await vscode.window.showInputBox({ prompt: 'Folder for the project, relative to the workspace', value: model.projects.length ? path.join(sub, slugify(name)) : sub || 'tasks' });
        if (rel === undefined) return;
        dir = path.join(folder.uri.fsPath, rel);
      }
      const file = await createProject(dir, { name: name.trim(), description: '', owner: defaultAuthor(parent?.dir) });
      await model.reload();
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    },

    'mdpm.approve': async (arg, selected) => flow.approve(model, requireTasks(arg, selected)),
    'mdpm.accept': async (arg, selected) => flow.accept(model, requireTasks(arg, selected)),
    'mdpm.rework': one((t) => flow.rework(model, t)),
    'mdpm.unblock': one((t) => flow.unblock(model, t)),
    'mdpm.replan': one((t) => flow.replan(model, t)),
    'mdpm.moveBackToPlan': one((t) => flow.pause(model, t)),
    'mdpm.planNow': one(planNow),
    'mdpm.runNext': () => runNext(false),
    'mdpm.runUntilIdle': () => runNext(true),
    'mdpm.continueWithAgent': one(continueWithAgent),

    'mdpm.openPr': one(async (task) => {
      if (task.pr) return vscode.env.openExternal(vscode.Uri.parse(task.pr));
      vscode.window.showInformationMessage(
        `mdpm: "${task.title}" has no pull request${task.branch ? `; its work is on branch ${task.branch}. Check it out to review it (git switch ${task.branch}), or install and log in to the GitHub CLI (gh auth login) to get pull requests on handoff.` : '.'}`,
      );
    }),

    'mdpm.linkTask': async (arg) => {
      const task = requireTask(arg);
      if (!task) return;
      const target = await pickProject(`Also show "${task.title}" in…`, task.locations.map((l) => l.project));
      if (!target) return;
      const link = await linkTask(task.file, target.dir);
      await model.reload();
      if (link.kind === 'stub') {
        const help = await vscode.window.showWarningMessage(
          'mdpm: the idea was linked, but this machine does not allow symlinks, so a small text file holding the path was written instead. ' +
            'mdpm treats it the same way. To get real symlinks, enable Windows Developer Mode and run "git config core.symlinks true".',
          'How to Enable Developer Mode',
        );
        if (help) await vscode.env.openExternal(vscode.Uri.parse('https://learn.microsoft.com/windows/apps/get-started/enable-your-device-for-development'));
      }
    },

    'mdpm.unlinkTask': async (arg) => {
      if (!arg || !('kind' in arg) || arg.kind !== 'task' || !arg.location.link) return;
      const ok = await vscode.window.showWarningMessage(`Remove "${arg.task.title}" from ${arg.location.project.name}? The idea itself stays in ${arg.task.home.name}.`, { modal: true }, 'Remove');
      if (!ok) return;
      await unlinkTask(arg.location.path);
      await model.reload();
    },

    'mdpm.openProjectFile': async (arg) => {
      const p = projectOf(arg);
      if (p) await vscode.window.showTextDocument(vscode.Uri.file(p.file));
    },

    'mdpm.revealInExplorer': async (arg) => {
      if (!arg || !('kind' in arg) || arg.kind === 'stage') return;
      const target = arg.kind === 'project' ? arg.project.dir : arg.location.path;
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(target));
    },
  };

  for (const [id, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(id, run(fn)));

  await model.reload();
  updateContext();
  updateStatus();
}

export function deactivate() {}

function depth(p: Project): number {
  return p.parent ? depth(p.parent) + 1 : 0;
}

function rootOf(p: Project): string {
  return p.parent ? rootOf(p.parent) : path.dirname(p.dir);
}
