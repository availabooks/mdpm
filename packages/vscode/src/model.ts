import {
  BLOCKED_STATUS,
  Issue,
  Project,
  Task,
  WriteBack,
  Workspace,
  agentDefinitions,
  agentNames,
  applyStatusDefaults,
  bodyAfter,
  loadWorkspace,
  previewTaskChange,
  toPosix,
  updateTask,
  writeBack,
} from '@mdpm/core';
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
  /** The owner is an agent (shown with a robot badge). */
  agentOwned: boolean;
}

export interface ModelDTO {
  projects: ProjectDTO[];
  tasks: TaskDTO[];
  statuses: string[];
  owners: string[];
  /** Agent that "Send to agent" uses (setting `mdpm.agent.default`). */
  defaultAgent: string;
}

function describe(issues: Issue[]): string {
  return issues.map((i) => `• ${i.message}`).join('\n');
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
      const line = Math.max(0, (issue.line ?? 1) - 1);
      const d = new vscode.Diagnostic(
        new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        issue.message,
        issue.level === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      d.source = 'mdpm';
      d.code = issue.code;
      byFile.set(issue.file, [...(byFile.get(issue.file) ?? []), d]);
    }
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.file(file), list);
  }

  /**
   * Writes front matter changes after validating them. Errors ask for confirmation
   * ("Save Anyway"); warnings are shown after saving. Returns whether the file was written.
   */
  async update(task: Task, requested: Record<string, unknown>, log?: { text: string; by: string }): Promise<boolean> {
    const wb: WriteBack = { changes: applyStatusDefaults(task, requested), log: log?.text, by: log?.by ?? '' };
    const ws = this.workspaces.find((w) => w.tasks.includes(task));
    const issues = ws ? previewTaskChange(ws, task, wb.changes, bodyAfter(task, wb)) : [];
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) {
      const choice = await vscode.window.showErrorMessage(
        `mdpm: this change would make "${task.title}" invalid, so it was not saved.`,
        { modal: true, detail: describe(errors) },
        'Save Anyway',
      );
      if (choice !== 'Save Anyway') {
        this.changed.fire(); // let views drop their optimistic update
        return false;
      }
    }
    await writeBack(task.file, wb);
    await this.reload();
    const warnings = issues.filter((i) => i.level === 'warning');
    if (warnings.length) vscode.window.showWarningMessage(`mdpm: saved "${task.title}", with warnings: ${describe(warnings)}`);
    return true;
  }

  /**
   * Bulk version of `update()`: validates every change first and asks once about all the
   * invalid ones ("Save Anyway" / "Skip Invalid"), writes, then reloads once.
   * Returns the tasks that were written.
   */
  async updateMany(requested: { task: Task; changes: Record<string, unknown> }[]): Promise<Task[]> {
    if (requested.length === 1) return (await this.update(requested[0].task, requested[0].changes)) ? [requested[0].task] : [];
    const items = requested.map(({ task, changes }) => {
      const full = applyStatusDefaults(task, changes);
      const ws = this.workspaces.find((w) => w.tasks.includes(task));
      const issues = ws ? previewTaskChange(ws, task, full) : [];
      return { task, requested: changes, changes: full, issues };
    });
    const invalid = items.filter((i) => i.issues.some((x) => x.level === 'error'));
    let toWrite = items;
    if (invalid.length) {
      const valid = items.length - invalid.length;
      const detail =
        invalid.map((i) => `"${i.task.title}":\n${describe(i.issues.filter((x) => x.level === 'error'))}`).join('\n\n') +
        `\n\nSave Anyway writes all ${items.length} tasks and you can fix the front matter afterwards.` +
        (valid ? ` Skip Invalid saves only the other ${valid}.` : '');
      const choice = await vscode.window.showErrorMessage(
        `mdpm: this change would make ${invalid.length} of the ${items.length} selected tasks invalid, so nothing was saved yet.`,
        { modal: true, detail },
        ...(valid ? ['Save Anyway', 'Skip Invalid'] : ['Save Anyway']),
      );
      if (choice === 'Skip Invalid') toWrite = items.filter((i) => !invalid.includes(i));
      else if (choice !== 'Save Anyway') {
        this.changed.fire(); // let views drop their optimistic update
        return [];
      }
    }

    const failed: { item: (typeof items)[number]; error: string }[] = [];
    for (const item of toWrite) {
      try {
        await updateTask(item.task.file, item.changes);
      } catch (e) {
        failed.push({ item, error: e instanceof Error ? e.message : String(e) });
      }
    }
    await this.reload(); // once, and it also reverts views to what is on disk for failed writes

    const saved = toWrite.filter((i) => !failed.some((f) => f.item === i));
    const warned = saved.filter((i) => i.issues.some((x) => x.level === 'warning'));
    if (warned.length) {
      vscode.window.showWarningMessage(
        `mdpm: saved ${saved.length} tasks, with warnings: ` +
          warned.map((i) => `"${i.task.title}": ${describe(i.issues.filter((x) => x.level === 'warning'))}`).join(' '),
      );
    }
    if (failed.length) void this.offerRetry(failed.map((f) => ({ task: f.item.task, changes: f.item.requested, error: f.error })));
    return saved.map((i) => i.task);
  }

  private async offerRetry(failed: { task: Task; changes: Record<string, unknown>; error: string }[]) {
    const choice = await vscode.window.showErrorMessage(
      `mdpm: ${failed.length} task${failed.length > 1 ? 's were' : ' was'} not saved: ` +
        failed.map((f) => `"${f.task.title}" (${f.error})`).join('; ') +
        '. The views show what is on disk. Fix the problem (for example, make the files writable), then click Retry to save just these tasks again.',
      'Retry',
    );
    if (choice !== 'Retry') return;
    const retry = failed.map((f) => ({ task: this.task(f.task.file), changes: f.changes }));
    const gone = failed.filter((_, i) => !retry[i].task);
    if (gone.length) {
      vscode.window.showErrorMessage(
        `mdpm: ${gone.map((f) => `"${f.task.title}"`).join(', ')} could not be found any more (moved or deleted?), so ${gone.length > 1 ? 'they were' : 'it was'} not retried. ` +
          'Run "mdpm: Refresh", select the tasks again and repeat the change.',
      );
    }
    const present = retry.filter((r): r is { task: Task; changes: Record<string, unknown> } => !!r.task);
    try {
      if (present.length) await this.updateMany(present);
    } catch (e) {
      // only the single-task path throws; updateMany reports its own write failures
      vscode.window.showErrorMessage(
        `mdpm: "${present[0].task.title}" was still not saved: ${e instanceof Error ? e.message : e} Fix the problem, then make the change again.`,
      );
    }
  }

  workspaceOf(task: Task): Workspace | undefined {
    return this.workspaces.find((w) => w.tasks.includes(task));
  }

  /** Agent names, the default first: the presets plus any defined in root .proj files. */
  agents(): string[] {
    const names = new Set(this.workspaces.flatMap((w) => Object.keys(agentDefinitions(w).agents)));
    const def = this.defaultAgent();
    return [def, ...[...names].filter((n) => n !== def).sort()];
  }

  defaultAgent(): string {
    return vscode.workspace.getConfiguration('mdpm').get<string>('agent.default')?.trim() || 'claude';
  }

  isAgent(task: Task): boolean {
    const ws = this.workspaceOf(task);
    return !!task.owner && !!ws && agentNames(ws).has(task.owner);
  }

  isBlocked(task: Task): boolean {
    return task.status === BLOCKED_STATUS;
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

    const tasks: TaskDTO[] = this.workspaces.flatMap((ws) => {
      const agents = agentNames(ws);
      return ws.tasks.map((t) => ({
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
        agentOwned: !!t.owner && agents.has(t.owner),
      }));
    });

    return {
      projects,
      tasks,
      statuses: [...new Set(projects.flatMap((p) => p.statuses))],
      owners: [...new Set(tasks.map((t) => t.owner).filter((o): o is string => !!o))].sort(),
      defaultAgent: this.defaultAgent(),
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
