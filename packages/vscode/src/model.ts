import { Project, Task, Workspace, loadWorkspace, toPosix } from '@mdpm/core';
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Plain, serializable views of the model that are sent to webviews. Keys are absolute paths. */
export interface ProjectDTO {
  key: string;
  name: string;
  parent?: string;
  depth: number;
  statuses: string[];
  relPath: string;
}

export interface TaskDTO {
  key: string;
  id: string;
  title: string;
  status: string;
  owner?: string;
  start?: string;
  end?: string;
  priority?: string | number;
  tags: string[];
  dependsOn: string[];
  home: string;
  projects: string[];
  shared: boolean;
  relPath: string;
}

export interface ModelDTO {
  projects: ProjectDTO[];
  tasks: TaskDTO[];
  statuses: string[];
  owners: string[];
}

export class Model implements vscode.Disposable {
  workspaces: Workspace[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('mdpm');
  private readonly disposables: vscode.Disposable[] = [this.changed, this.diagnostics];
  private queue: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private warnedRoot?: string;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/{*.md,*.task,.proj}');
    const schedule = () => this.scheduleReload();
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    this.disposables.push(
      watcher,
      vscode.workspace.onDidChangeWorkspaceFolders(schedule),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('mdpm') && schedule()),
    );
  }

  get projects(): Project[] {
    return this.workspaces.flatMap((w) => w.projects);
  }

  get tasks(): Task[] {
    return this.workspaces.flatMap((w) => w.tasks);
  }

  /** Reloads everything. Calls are serialized so a burst of edits can't race. */
  reload(): Promise<void> {
    this.queue = this.queue.then(() => this.load()).catch((e) => {
      vscode.window.showErrorMessage(
        `mdpm: failed to load tasks (${e instanceof Error ? e.message : e}). Fix the problem, then run "mdpm: Refresh" from the Command Palette.`,
      );
    });
    return this.queue;
  }

  scheduleReload() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.reload(), 250);
  }

  private async load() {
    const sub = vscode.workspace.getConfiguration('mdpm').get<string>('root') ?? '';
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    const roots = folders.map((f) => path.join(f.uri.fsPath, sub));
    const missing = roots.filter((r) => !existsSync(r));
    if (sub && missing.length && this.warnedRoot !== sub) {
      this.warnedRoot = sub; // once per setting value, not on every file change
      this.warnMissingRoot(sub, missing);
    }
    this.workspaces = await Promise.all(roots.filter((r) => existsSync(r)).map((r) => loadWorkspace(r)));
    this.updateDiagnostics();
    this.changed.fire();
  }

  private async warnMissingRoot(sub: string, missing: string[]) {
    const choice = await vscode.window.showWarningMessage(
      `mdpm: the "mdpm.root" setting is "${sub}", but ${missing.join(', ')} does not exist, so no tasks were loaded from there. ` +
        'Change the setting to the folder that holds your .proj files, or clear it to scan the whole workspace.',
      'Open Settings',
    );
    if (choice) await vscode.commands.executeCommand('workbench.action.openSettings', 'mdpm.root');
  }

  private updateDiagnostics() {
    this.diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const issue of this.workspaces.flatMap((w) => w.issues)) {
      const d = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 3),
        issue.message,
        issue.level === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      d.source = 'mdpm';
      byFile.set(issue.file, [...(byFile.get(issue.file) ?? []), d]);
    }
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.file(file), list);
  }

  project(key: string): Project | undefined {
    return this.projects.find((p) => p.file === key);
  }

  /** Finds a task by its real file or any of the paths it appears at. */
  task(fsPath: string): Task | undefined {
    const norm = path.normalize(fsPath);
    return this.tasks.find((t) => t.file === norm || t.locations.some((l) => l.path === norm));
  }

  toDTO(): ModelDTO {
    const projects: ProjectDTO[] = [];
    const visit = (p: Project, depth: number, ws: Workspace) => {
      projects.push({
        key: p.file,
        name: p.name,
        parent: p.parent?.file,
        depth,
        statuses: p.statuses,
        relPath: this.relPath(ws, p.dir),
      });
      p.children.forEach((c) => visit(c, depth + 1, ws));
    };
    for (const ws of this.workspaces) ws.projects.filter((p) => !p.parent).forEach((p) => visit(p, 0, ws));

    const tasks: TaskDTO[] = this.workspaces.flatMap((ws) =>
      ws.tasks.map((t) => ({
        key: t.file,
        id: t.id,
        title: t.title,
        status: t.status,
        owner: t.owner,
        start: t.start,
        end: t.end,
        priority: t.priority,
        tags: t.tags,
        dependsOn: t.dependsOn,
        home: t.home.file,
        projects: t.locations.map((l) => l.project.file),
        shared: t.locations.length > 1,
        relPath: this.relPath(ws, t.file),
      })),
    );

    return {
      projects,
      tasks,
      statuses: [...new Set(projects.flatMap((p) => p.statuses))],
      owners: [...new Set(tasks.map((t) => t.owner).filter((o): o is string => !!o))].sort(),
    };
  }

  private relPath(ws: Workspace, p: string): string {
    const prefix = this.workspaces.length > 1 ? `${path.basename(ws.root)}/` : '';
    return prefix + (toPosix(path.relative(ws.root, p)) || '.');
  }

  dispose() {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}
