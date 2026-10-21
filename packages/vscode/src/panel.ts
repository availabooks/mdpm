import * as crypto from 'crypto';
import { FlowStage, Task } from '@mdpm/core';
import * as vscode from 'vscode';
import * as flow from './flow';
import { Model } from './model';

/** Card and toolbar buttons on the board; each runs the extension command of the same name. */
export type BoardAction = 'approve' | 'accept' | 'rework' | 'unblock' | 'replan' | 'planNow' | 'continue' | 'openPr' | 'runNext';

type Message =
  | { type: 'ready' }
  | { type: 'open'; file: string }
  | { type: 'drop'; file: string; stage: FlowStage }
  | { type: 'approveMany'; files: string[] }
  | { type: 'acceptMany'; files: string[] }
  | { type: 'newIdea'; project?: string }
  | { type: 'action'; action: BoardAction; file?: string };

const COMMANDS: Record<BoardAction, string> = {
  approve: 'mdpm.approve',
  accept: 'mdpm.accept',
  rework: 'mdpm.rework',
  unblock: 'mdpm.unblock',
  replan: 'mdpm.replan',
  planNow: 'mdpm.planNow',
  continue: 'mdpm.continueWithAgent',
  openPr: 'mdpm.openPr',
  runNext: 'mdpm.runNext',
};

/** Hosts the flow board webview (one panel). */
export class BoardPanel {
  private static current?: BoardPanel;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, model: Model, project?: string) {
    if (BoardPanel.current) {
      BoardPanel.current.panel.reveal();
      if (project) BoardPanel.current.panel.webview.postMessage({ type: 'focusProject', project });
      return;
    }
    BoardPanel.current = new BoardPanel(extensionUri, model, project);
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly model: Model,
    private initialProject?: string,
  ) {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('mdpm.flow', 'mdpm: Flow', vscode.ViewColumn.Active, {
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
        case 'drop':
          await flow.drop(this.model, this.task(m.file), m.stage);
          break;
        case 'approveMany':
          await flow.approve(this.model, this.tasks(m.files));
          break;
        case 'acceptMany':
          await flow.accept(this.model, this.tasks(m.files));
          break;
        case 'newIdea':
          await vscode.commands.executeCommand('mdpm.newIdea', { projectKey: m.project });
          break;
        case 'action':
          await vscode.commands.executeCommand(COMMANDS[m.action], m.file ? { taskFile: this.task(m.file).file } : undefined);
          break;
      }
    } catch (e) {
      vscode.window.showErrorMessage(`mdpm: the change was not saved: ${e instanceof Error ? e.message : e} The board shows what is on disk.`);
      this.post(); // revert optimistic UI changes
    }
  }

  private task(file: string) {
    const task = this.model.task(file);
    if (!task) throw new Error(`${file} is no longer an idea (it may have been moved or deleted). Run "mdpm: Refresh" and try again.`);
    return task;
  }

  /** All ideas for `files`; names every file that is gone, so nothing is changed half-way. */
  private tasks(files: string[]) {
    const tasks = files.map((f) => this.model.task(f));
    const gone = files.filter((_, i) => !tasks[i]);
    if (gone.length) {
      throw new Error(
        `${gone.join(', ')} ${gone.length > 1 ? 'are' : 'is'} no longer an idea (moved or deleted?), so none of the ${files.length} selected ideas were changed. ` +
          'Run "mdpm: Refresh", select them again and repeat the change.',
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
<title>Flow</title>
</head>
<body class="flow">
<div id="toolbar" class="toolbar"></div>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('common.js')}"></script>
<script nonce="${nonce}" src="${uri('flow.js')}"></script>
</body>
</html>`;
  }

  private dispose() {
    BoardPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }
}
