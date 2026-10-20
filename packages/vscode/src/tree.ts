import { FLOW_STAGES, FLOW_STAGE_INFO, FlowStage, Project, Task, TaskLocation, activityVerb, ago, describeStatus, flowStage, isApproved } from '@mdpm/core';
import * as vscode from 'vscode';
import { Model } from './model';

export type Node =
  | { kind: 'project'; project: Project }
  | { kind: 'stage'; project: Project; stage: FlowStage }
  | { kind: 'task'; task: Task; location: TaskLocation };

/** Projects, and inside each the ideas grouped by flow stage. */
export class ProjectTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly model: Model) {
    model.onDidChange(() => this.changed.fire());
  }

  private ideasIn(p: Project) {
    return this.model.tasks.flatMap((task) => task.locations.filter((l) => l.project === p).map((location) => ({ task, location })));
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.model.projects.filter((p) => !p.parent).map((project) => ({ kind: 'project', project }));
    if (node.kind === 'task') return [];
    if (node.kind === 'stage') {
      return this.ideasIn(node.project)
        .filter(({ task }) => flowStage(task) === node.stage)
        .sort((a, b) => Number(b.task.status === 'blocked') - Number(a.task.status === 'blocked') || a.task.title.localeCompare(b.task.title))
        .map(({ task, location }) => ({ kind: 'task' as const, task, location }));
    }
    const p = node.project;
    const ideas = this.ideasIn(p);
    const stages = FLOW_STAGES.filter((s) => ideas.some(({ task }) => flowStage(task) === s));
    return [...p.children.map((project) => ({ kind: 'project' as const, project })), ...stages.map((stage) => ({ kind: 'stage' as const, project: p, stage }))];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'project') {
      const p = node.project;
      const item = new vscode.TreeItem(p.name, p.parent ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.id = p.file;
      item.iconPath = new vscode.ThemeIcon(p.parent ? 'folder' : 'project');
      item.contextValue = 'project';
      item.resourceUri = vscode.Uri.file(p.dir);
      const description = typeof p.meta.description === 'string' ? p.meta.description : '';
      item.tooltip = new vscode.MarkdownString(`**${p.name}**\n\n${description}\n\n\`${p.dir}\``);
      item.description = description;
      return item;
    }

    if (node.kind === 'stage') {
      const info = FLOW_STAGE_INFO[node.stage];
      const ideas = this.ideasIn(node.project).filter(({ task }) => flowStage(task) === node.stage);
      const item = new vscode.TreeItem(info.label, node.stage === 'done' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${node.project.file}#${node.stage}`;
      item.iconPath = new vscode.ThemeIcon(STAGE_ICONS[node.stage]);
      item.description = `${ideas.length}`;
      item.tooltip = info.hint;
      item.contextValue = 'stage';
      return item;
    }

    const { task, location } = node;
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.id = location.path;
    // e.g. "ideaLink:plan-approved"; menus match the start with /^idea/ and the state after the colon.
    const running = this.model.runningOn(task);
    const state = running ? 'running' : isApproved(task) ? 'plan-approved' : task.status;
    item.contextValue = `${location.link ? 'ideaLink' : 'idea'}:${state}`;
    item.iconPath = running ? new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.purple')) : stateIcon(task);
    item.description = [running ? `${running.agent} ${activityVerb(running.mode)}…` : stateText(task), location.link && '↪ linked'].filter(Boolean).join(' · ');
    item.resourceUri = vscode.Uri.file(task.file);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${task.title}** \`${task.id}\``,
        running ? `**${running.agent} is ${activityVerb(running.mode)}** (started ${ago(running.started)} ago)` : '',
        describeStatus(task),
        task.branch ? `branch: \`${task.branch}\`` : '',
        task.locations.length > 1 ? `in: ${task.locations.map((l) => l.project.name).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(task.file)] };
    return item;
  }
}

const STAGE_ICONS: Record<FlowStage, string> = { idea: 'lightbulb', plan: 'checklist', executing: 'gear', review: 'eye', done: 'pass' };

function stateText(t: Task): string {
  if (t.status === 'blocked') return 'needs your answer';
  if (t.status === 'plan') return t.approved ? 'approved' : 'awaiting approval';
  if (t.status === 'review') return 'to review';
  return '';
}

function stateIcon(t: Task): vscode.ThemeIcon {
  if (t.status === 'blocked') return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
  if (t.status === 'done') return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
  if (t.status === 'review') return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.orange'));
  if (t.status === 'executing') return new vscode.ThemeIcon('circle-large-filled', new vscode.ThemeColor('charts.purple'));
  if (t.status === 'plan') return new vscode.ThemeIcon(t.approved ? 'circle-large-filled' : 'circle-large-outline', new vscode.ThemeColor('charts.blue'));
  return new vscode.ThemeIcon('circle-large-outline');
}
