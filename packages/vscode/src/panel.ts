import * as crypto from 'crypto';
import { FLOW_STAGE_INFO, FlowStage, statusForStage } from '@mdpm/core';
import * as vscode from 'vscode';
import { Task } from '@mdpm/core';
import { setOwner, setStatus } from './bulk';
import { Model } from './model';

export type PanelKind = 'board' | 'flow' | 'waterfall';

type Message =
  | { type: 'ready' }
  | { type: 'open'; file: string }
  | { type: 'setStatus'; file: string; status: string }
  | { type: 'setStage'; file: string; stage: FlowStage }
  | { type: 'setDates'; file: string; start?: string; end?: string }
  | { type: 'setStatusMany'; files: string[]; status?: string }
  | { type: 'setOwnerMany'; files: string[]; owner?: string }
  | { type: 'setDatesMany'; changes: { file: string; start?: string; end?: string }[] }
  | { type: 'newTask'; project?: string; status?: string }
  | { type: 'agent'; action: 'send' | 'sendAs' | 'unblock' | 'continue'; file: string };

const TITLES: Record<PanelKind, string> = { board: 'Kanban', flow: 'AI Flow', waterfall: 'Waterfall' };

/** Hosts the board and waterfall webviews; one panel per kind. */
export class ViewPanel {
  private static readonly open = new Map<PanelKind, ViewPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(kind: PanelKind, extensionUri: vscode.Uri, model: Model, project?: string) {
    const existing = ViewPanel.open.get(kind);
    if (existing) {
      existing.panel.reveal();
      if (project) existing.panel.webview.postMessage({ type: 'focusProject', project });
      return;
    }
    ViewPanel.open.set(kind, new ViewPanel(kind, extensionUri, model, project));
  }

  private constructor(
    private readonly kind: PanelKind,
    extensionUri: vscode.Uri,
    private readonly model: Model,
    private initialProject?: string,
  ) {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(`mdpm.${kind}`, `mdpm: ${TITLES[kind]}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    this.panel.webview.html = this.html(media);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: Message) => this.handle(m)),
      model.onDidChange(() => this.post()),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private post() {
    this.panel.webview.postMessage({ type: 'model', data: this.model.toDTO() });
  }

  private async handle(m: Message) {
    try {
      switch (m.type) {
        case 'ready':
          this.post();
          if (this.initialProject) this.panel.webview.postMessage({ type: 'focusProject', project: this.initialProject });
          this.initialProject = undefined;
          break;
        case 'open':
          await vscode.window.showTextDocument(vscode.Uri.file(m.file), { viewColumn: vscode.ViewColumn.Beside, preview: true });
          break;
        case 'setStatus':
          await this.model.update(this.task(m.file), { status: m.status });
          break;
        case 'setStage': {
          const task = this.task(m.file);
          const status = statusForStage(m.stage, task.home.statuses);
          if (!status) {
            throw new Error(
              `${task.home.name} has no status for the "${FLOW_STAGE_INFO[m.stage].label}" stage (its statuses are ${task.home.statuses.join(', ')}). ` +
                `Add one of ${FLOW_STAGE_INFO[m.stage].statuses.filter((s) => s !== 'blocked').join(', ')} to "statuses" in its .proj file.`,
            );
          }
          if (status !== task.status) await this.model.update(task, { status });
          else this.post();
          break;
        }
        case 'setDates':
          await this.model.update(this.task(m.file), { start: m.start, end: m.end });
          break;
        case 'setStatusMany':
          await setStatus(this.model, this.tasks(m.files), m.status);
          break;
        case 'setOwnerMany':
          await setOwner(this.model, this.tasks(m.files), m.owner);
          break;
        case 'setDatesMany': {
          const tasks = this.tasks(m.changes.map((c) => c.file));
          await this.model.updateMany(m.changes.map((c, i) => ({ task: tasks[i], changes: { start: c.start, end: c.end } })));
          break;
        }
        case 'newTask':
          await vscode.commands.executeCommand('mdpm.newTask', { projectKey: m.project, status: m.status });
          break;
        case 'agent': {
          const command = { send: 'mdpm.sendToAgent', sendAs: 'mdpm.sendToAgentAs', unblock: 'mdpm.unblock', continue: 'mdpm.continueWithAgent' }[m.action];
          await vscode.commands.executeCommand(command, { taskFile: this.task(m.file).file });
          break;
        }
      }
    } catch (e) {
      vscode.window.showErrorMessage(
        `mdpm: the change was not saved: ${e instanceof Error ? e.message : e} The view has been reset to what is on disk.`,
      );
      this.post(); // revert optimistic UI changes
    }
  }

  private task(file: string) {
    const task = this.model.task(file);
    if (!task) throw new Error(`${file} is no longer a task (it may have been moved or deleted). Run "mdpm: Refresh" and try again.`);
    return task;
  }

  /** All tasks for `files`; names every file that is gone, so nothing is changed half-way. */
  private tasks(files: string[]) {
    const tasks = files.map((f) => this.model.task(f));
    const gone = files.filter((_, i) => !tasks[i]);
    if (gone.length) {
      throw new Error(
        `${gone.join(', ')} ${gone.length > 1 ? 'are' : 'is'} no longer a task (moved or deleted?), so none of the ${files.length} selected tasks were changed. ` +
          'Run "mdpm: Refresh", select the tasks again and repeat the change.',
      );
    }
    return tasks as Task[];
  }

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('style.css')}">
<title>${TITLES[this.kind]}</title>
</head>
<body class="${this.kind}">
<div id="toolbar" class="toolbar"></div>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('common.js')}"></script>
<script nonce="${nonce}" src="${uri(`${this.kind}.js`)}"></script>
</body>
</html>`;
  }

  private dispose() {
    ViewPanel.open.delete(this.kind);
    this.disposables.forEach((d) => d.dispose());
  }
}
