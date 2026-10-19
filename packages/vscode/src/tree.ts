import { BLOCKED_STATUS, Project, Task, TaskLocation, activityVerb, ago } from '@mdpm/core';
import * as vscode from 'vscode';
import { Model } from './model';

export type Node = { kind: 'project'; project: Project } | { kind: 'task'; task: Task; location: TaskLocation };

export class ProjectTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly model: Model) {
    model.onDidChange(() => this.changed.fire());
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.model.projects.filter((p) => !p.parent).map((project) => ({ kind: 'project', project }));
    if (node.kind === 'task') return [];
    const p = node.project;
    const children: Node[] = p.children.map((project) => ({ kind: 'project', project }));
    const tasks = this.model.tasks
      .flatMap((task) => task.locations.filter((l) => l.project === p).map((location) => ({ task, location })))
      .sort((a, b) => statusRank(a.task) - statusRank(b.task) || a.task.title.localeCompare(b.task.title));
    return [...children, ...tasks.map(({ task, location }) => ({ kind: 'task' as const, task, location }))];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'project') {
      const p = node.project;
      const item = new vscode.TreeItem(
        p.name,
        p.parent ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = p.file;
      item.iconPath = new vscode.ThemeIcon(p.parent ? 'folder' : 'project');
      item.contextValue = 'project';
      item.resourceUri = vscode.Uri.file(p.dir);
      const description = typeof p.meta.description === 'string' ? p.meta.description : '';
      item.tooltip = new vscode.MarkdownString(`**${p.name}**\n\n${description}\n\n\`${p.dir}\``);
      item.description = description;
      return item;
    }

    const { task, location } = node;
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.id = location.path;
    // e.g. "taskLink:blocked"; menus match the start with /^task/ and the state with /:blocked/.
    const running = this.model.runningOn(task);
    const state = running ? 'running' : task.status === BLOCKED_STATUS ? 'blocked' : isFinal(task) ? 'done' : 'open';
    item.contextValue = `${location.link ? 'taskLink' : 'task'}:${state}`;
    item.iconPath = running ? new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.purple')) : statusIcon(task);
    const owner = task.owner && `${this.model.isAgent(task) ? '🤖 ' : '@'}${task.owner}`;
    item.description = [task.status, running ? `${running.agent} ${activityVerb(running.mode)}…` : owner, location.link && '↪ linked'].filter(Boolean).join(' · ');
    item.resourceUri = vscode.Uri.file(task.file);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${task.title}** \`${task.id}\``,
        running ? `**${running.agent} is ${activityVerb(running.mode)}** (started ${ago(running.started)} ago)` : '',
        `status: ${task.status}${task.owner ? ` · owner: ${task.owner}` : ''}`,
        task.start || task.end ? `${task.start ?? '?'} → ${task.end ?? '?'}` : '',
        task.locations.length > 1 ? `in: ${task.locations.map((l) => l.project.name).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(task.file)] };
    return item;
  }
}

function statusRank(t: Task): number {
  const i = t.home.statuses.indexOf(t.status);
  return i < 0 ? 999 : i;
}

function isFinal(t: Task): boolean {
  return t.status === t.home.statuses[t.home.statuses.length - 1];
}

function statusIcon(t: Task): vscode.ThemeIcon {
  const i = t.home.statuses.indexOf(t.status);
  const last = t.home.statuses.length - 1;
  if (t.status === BLOCKED_STATUS) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
  if (i === last) return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
  if (i <= 0) return new vscode.ThemeIcon('circle-large-outline');
  return new vscode.ThemeIcon('circle-large-filled', new vscode.ThemeColor('charts.blue'));
}
