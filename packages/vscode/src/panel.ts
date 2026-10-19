import { updateTask } from '@mdpm/core';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { Model } from './model';

export type PanelKind = 'board' | 'waterfall';

type Message =
  | { type: 'ready' }
  | { type: 'open'; file: string }
  | { type: 'setStatus'; file: string; status: string }
  | { type: 'setDates'; file: string; start?: string; end?: string }
  | { type: 'newTask'; project?: string; status?: string };

const TITLES: Record<PanelKind, string> = { board: 'Kanban', waterfall: 'Waterfall' };

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
          await updateTask(m.file, { status: m.status });
          await this.model.reload();
          break;
        case 'setDates':
          await updateTask(m.file, { start: m.start, end: m.end });
          await this.model.reload();
          break;
        case 'newTask':
          await vscode.commands.executeCommand('mdpm.newTask', { projectKey: m.project, status: m.status });
          break;
      }
    } catch (e) {
      vscode.window.showErrorMessage(
        `mdpm: the change was not saved: ${e instanceof Error ? e.message : e} The view has been reset to what is on disk.`,
      );
      this.post(); // revert optimistic UI changes
    }
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
