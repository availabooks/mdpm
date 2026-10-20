import {
  ActiveRun,
  BLOCKED_STATUS,
  CriteriaProgress,
  FLOW_STAGES,
  FLOW_STAGE_INFO,
  FlowStage,
  FlowStageInfo,
  Issue,
  Project,
  Task,
  Workspace,
  WriteBack,
  acceptanceCriteria,
  agentDefinitions,
  bodyAfter,
  flowQueue,
  flowStage,
  isApproved,
  loadWorkspace,
  needsPerson,
  openQuestions,
  planQueueOrder,
  previewTaskChange,
  readActive,
  slotHolder,
  stateDirFor,
  toPosix,
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
  relPath: string;
}

export interface TaskDTO {
  key: string;
  id: string;
  title: string;
  status: string;
  /** Column on the flow board (a blocked idea stays in the column it was blocked from). */
  stage: FlowStage;
  /** A plan the person approved, waiting to be executed. */
  approved: boolean;
  /** 1-based place in the execution queue, for approved plans. */
  queue?: number;
  priority?: string | number;
  tags: string[];
  home: string;
  projects: string[];
  shared: boolean;
  relPath: string;
  /** Checked / total acceptance criteria. */
  criteria: CriteriaProgress;
  /** Open questions under `## Questions`. */
  questions: number;
  /** Branch the idea is built on, once it has started executing. */
  branch?: string;
  pr?: string;
  /** Waiting on the person: blocked, a plan to approve, or work to review. */
  needsYou: boolean;
  /** An agent is working on this idea right now. */
  running?: { agent: string; mode: string; started: string };
}

export interface ModelDTO {
  projects: ProjectDTO[];
  tasks: TaskDTO[];
  /** Columns of the flow board, in order. */
  stages: FlowStageInfo[];
  /** The idea holding the execution slot. */
  slot: { key: string; id: string; title: string; status: string } | null;
  /** What the next agent run would do. */
  next: { key: string; id: string; mode: 'plan' | 'execute'; resume: boolean } | null;
  /** Agent the board's run buttons use (setting `mdpm.agent.default`). */
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
    // Agent activity markers change every few seconds (heartbeats); only a change in who is working reloads the views.
    const activity = vscode.workspace.createFileSystemWatcher('**/.mdpm/active/*.json');
    const refresh = () => void this.refreshActive().then((changed) => changed && this.changed.fire());
    activity.onDidCreate(refresh);
    activity.onDidChange(refresh);
    activity.onDidDelete(refresh);
    // A run that died stops sending heartbeats; this notices that.
    const poll = setInterval(refresh, 15_000);
    this.disposables.push(
      watcher,
      activity,
      { dispose: () => clearInterval(poll) },
      vscode.workspace.onDidChangeWorkspaceFolders(schedule),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('mdpm') && schedule()),
    );
  }

  /** Agents working right now (see `.mdpm/active/`). */
  active: ActiveRun[] = [];
  private activeSig = '';
  private readonly stateDirs = new Map<string, string>();

  /** Re-reads the activity markers. Returns whether who is working on what changed. */
  private async refreshActive(): Promise<boolean> {
    const runs: ActiveRun[] = [];
    for (const ws of this.workspaces) {
      let dir = this.stateDirs.get(ws.root);
      if (!dir) {
        dir = stateDirFor(ws.root);
        if (dir) this.stateDirs.set(ws.root, dir);
      }
      if (dir) runs.push(...(await readActive(dir)));
    }
    const sig = runs.map((r) => `${r.task}|${r.agent}|${r.mode}|${r.started}`).join(';');
    const changed = sig !== this.activeSig;
    this.active = runs;
    this.activeSig = sig;
    return changed;
  }

  /** The agent working on `task` right now, if any. */
  runningOn(task: Task): ActiveRun | undefined {
    return this.active.find((r) => r.task === task.id);
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
        `mdpm: failed to load ideas (${e instanceof Error ? e.message : e}). Fix the problem, then run "mdpm: Refresh" from the Command Palette.`,
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
    await this.refreshActive();
    this.updateDiagnostics();
    this.changed.fire();
  }

  private async warnMissingRoot(sub: string, missing: string[]) {
    const choice = await vscode.window.showWarningMessage(
      `mdpm: the "mdpm.root" setting is "${sub}", but ${missing.join(', ')} does not exist, so no ideas were loaded from there. ` +
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
   * Writes flow write-backs after validating them, then reloads once. Changes that would make an
   * idea invalid are listed in one dialog ("Save Anyway" / "Skip Invalid"); warnings are shown
   * after saving. Returns the ideas that were written.
   */
  async apply(items: { task: Task; wb: WriteBack }[]): Promise<Task[]> {
    const checked = items.map((item) => {
      const ws = this.workspaceOf(item.task);
      return { ...item, issues: ws ? previewTaskChange(ws, item.task, item.wb.changes, bodyAfter(item.task, item.wb)) : [] };
    });
    const invalid = checked.filter((i) => i.issues.some((x) => x.level === 'error'));
    let toWrite = checked;
    if (invalid.length) {
      const valid = checked.length - invalid.length;
      const detail =
        invalid.map((i) => `"${i.task.title}":\n${describe(i.issues.filter((x) => x.level === 'error'))}`).join('\n\n') +
        (valid ? `\n\nSkip Invalid saves only the other ${valid}.` : '\n\nYou can save anyway and fix the front matter afterwards.');
      const choice = await vscode.window.showErrorMessage(
        checked.length === 1 ? `mdpm: this change would make "${checked[0].task.title}" invalid, so it was not saved.` : `mdpm: this change would make ${invalid.length} of the ${checked.length} ideas invalid, so nothing was saved yet.`,
        { modal: true, detail },
        ...(valid ? ['Save Anyway', 'Skip Invalid'] : ['Save Anyway']),
      );
      if (choice === 'Skip Invalid') toWrite = checked.filter((i) => !invalid.includes(i));
      else if (choice !== 'Save Anyway') {
        this.changed.fire(); // let views drop their optimistic update
        return [];
      }
    }

    const failed: { title: string; error: string }[] = [];
    const saved: typeof toWrite = [];
    for (const item of toWrite) {
      try {
        await writeBack(item.task.file, item.wb);
        saved.push(item);
      } catch (e) {
        failed.push({ title: item.task.title, error: e instanceof Error ? e.message : String(e) });
      }
    }
    await this.reload(); // once; it also reverts views to what is on disk for failed writes
    const warned = saved.filter((i) => i.issues.some((x) => x.level === 'warning'));
    if (warned.length) {
      vscode.window.showWarningMessage(`mdpm: saved, with warnings: ${warned.map((i) => `"${i.task.title}": ${describe(i.issues.filter((x) => x.level === 'warning'))}`).join(' ')}`);
    }
    if (failed.length) {
      vscode.window.showErrorMessage(
        `mdpm: ${failed.map((f) => `"${f.title}" (${f.error})`).join('; ')} ${failed.length > 1 ? 'were' : 'was'} not saved. The views show what is on disk. Fix the problem (for example, make the files writable) and try again.`,
      );
    }
    return saved.map((i) => i.task);
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

  isBlocked(task: Task): boolean {
    return task.status === BLOCKED_STATUS;
  }

  project(key: string): Project | undefined {
    return this.projects.find((p) => p.file === key);
  }

  /** Finds an idea by its real file or any of the paths it appears at. */
  task(fsPath: string): Task | undefined {
    const norm = path.normalize(fsPath);
    return this.tasks.find((t) => t.file === norm || t.locations.some((l) => l.path === norm));
  }

  toDTO(): ModelDTO {
    const projects: ProjectDTO[] = [];
    const visit = (p: Project, depth: number, ws: Workspace) => {
      projects.push({ key: p.file, name: p.name, parent: p.parent?.file, depth, relPath: this.relPath(ws, p.dir) });
      p.children.forEach((c) => visit(c, depth + 1, ws));
    };
    for (const ws of this.workspaces) ws.projects.filter((p) => !p.parent).forEach((p) => visit(p, 0, ws));

    let slot: ModelDTO['slot'] = null;
    let next: ModelDTO['next'] = null;
    const tasks: TaskDTO[] = this.workspaces.flatMap((ws) => {
      const order = ws.tasks.filter(isApproved).sort(planQueueOrder);
      const holder = slotHolder(ws);
      if (holder && !slot) slot = { key: holder.file, id: holder.id, title: holder.title, status: holder.status };
      const pick = flowQueue(ws).picks[0];
      if (pick && !next) next = { key: pick.task.file, id: pick.task.id, mode: pick.mode, resume: pick.resume };
      return ws.tasks.map((t) => {
        const running = this.runningOn(t);
        return {
          key: t.file,
          id: t.id,
          title: t.title,
          status: t.status,
          stage: flowStage(t),
          approved: isApproved(t),
          queue: isApproved(t) ? order.indexOf(t) + 1 : undefined,
          priority: t.priority,
          tags: t.tags,
          home: t.home.file,
          projects: t.locations.map((l) => l.project.file),
          shared: t.locations.length > 1,
          relPath: this.relPath(ws, t.file),
          criteria: acceptanceCriteria(t.body),
          questions: openQuestions(t.body).length,
          branch: t.branch,
          pr: t.pr,
          needsYou: needsPerson(t),
          running: running && { agent: running.agent, mode: running.mode, started: running.started },
        };
      });
    });

    return { projects, tasks, stages: FLOW_STAGES.map((s) => FLOW_STAGE_INFO[s]), slot, next, defaultAgent: this.defaultAgent() };
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
