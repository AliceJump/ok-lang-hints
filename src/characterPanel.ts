import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CharacterDataLoadResult,
  CharacterDataPaths,
  CharacterDataSources,
  configuredCharacterDataPaths,
  loadCharacterManagerData,
} from './characterData';

interface CharacterManagerMessage {
  type?: string;
  kind?: string;
  characterId?: string;
  fileName?: string;
  skillId?: string;
  effectId?: string;
  text?: string;
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index++) value += possible.charAt(Math.floor(Math.random() * possible.length));
  return value;
}

function resolveProjectDir(): string {
  const configuration = vscode.workspace.getConfiguration('okLangHints');
  const explicit = configuration.get<string>('characterProjectPath')?.trim();
  const taskProject = configuration.get<string>('okScriptProjectPath')?.trim();
  const selected = explicit || taskProject;
  if (selected) {
    const expanded = selected.replace(/^~/, process.env.USERPROFILE || '').replace(/[\\/]+$/, '');
    return path.resolve(expanded);
  }
  const folders = vscode.workspace.workspaceFolders || [];
  const matching = folders.find((folder) =>
    fs.existsSync(path.join(folder.uri.fsPath, 'assets', 'data', 'characters.json')) ||
    fs.existsSync(path.join(folder.uri.fsPath, 'assets', 'data', 'character_skills')),
  );
  return matching?.uri.fsPath || folders[0]?.uri.fsPath || '';
}

function configuredPaths(projectDir: string): CharacterDataPaths {
  const configuration = vscode.workspace.getConfiguration('okLangHints');
  return configuredCharacterDataPaths(projectDir, {
    masterFile: configuration.get<string>('characterMasterFile'),
    skillsDirectory: configuration.get<string>('characterSkillsDirectory'),
    localeFile: configuration.get<string>('characterLocaleFile'),
    effectsFile: configuration.get<string>('effectsFile'),
  });
}

export class CharacterManagerPanel implements vscode.Disposable {
  static current: CharacterManagerPanel | undefined;

  static show(extensionUri: vscode.Uri): void {
    if (CharacterManagerPanel.current) {
      CharacterManagerPanel.current.panel.reveal(vscode.ViewColumn.One);
      void CharacterManagerPanel.current.update(true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okLangHintsCharacterManager',
      '角色技能管理',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    CharacterManagerPanel.current = new CharacterManagerPanel(panel, extensionUri);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private watcherDisposables: vscode.Disposable[] = [];
  private sources: CharacterDataSources | undefined;
  private projectDir = '';
  private generation = 0;
  private refreshTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: CharacterManagerMessage) => {
        void this.onMessage(message);
      }),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('okLangHints.characterProjectPath') ||
          event.affectsConfiguration('okLangHints.characterMasterFile') ||
          event.affectsConfiguration('okLangHints.characterSkillsDirectory') ||
          event.affectsConfiguration('okLangHints.characterLocaleFile') ||
          event.affectsConfiguration('okLangHints.effectsFile') ||
          event.affectsConfiguration('okLangHints.okScriptProjectPath')
        ) {
          void this.update(true);
        }
      }),
    );
    panel.webview.html = this.buildHtml();
  }

  private buildHtml(): string {
    const file = path.join(this.extensionUri.fsPath, 'media', 'characterManager.html');
    try {
      const nonce = getNonce();
      return fs.readFileSync(file, 'utf-8').split('__CSP_NONCE__').join(nonce);
    } catch (error) {
      return `<!DOCTYPE html><html lang="zh-cn"><meta charset="UTF-8"><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:20px">无法读取角色管理面板：${error instanceof Error ? error.message : String(error)}</body></html>`;
    }
  }

  private async onMessage(message: CharacterManagerMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.update(false);
        break;
      case 'refresh':
        await this.update(true);
        break;
      case 'openSource':
        await this.openSource(message);
        break;
      case 'copy':
        if (typeof message.text === 'string') {
          await vscode.env.clipboard.writeText(message.text);
          void vscode.window.showInformationMessage(`已复制：${message.text}`);
        }
        break;
      default:
        break;
    }
  }

  private async update(forceWatcher = false): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    const projectDir = resolveProjectDir();
    if (!projectDir || !fs.existsSync(projectDir)) {
      this.projectDir = '';
      this.sources = undefined;
      this.disposeWatchers();
      await this.panel.webview.postMessage({
        type: 'error',
        text: '未找到角色数据项目。请配置 okLangHints.characterProjectPath 或 okLangHints.okScriptProjectPath。',
      });
      return;
    }

    await this.panel.webview.postMessage({ type: 'loading', projectDir });
    let result: CharacterDataLoadResult;
    try {
      result = loadCharacterManagerData(configuredPaths(projectDir));
    } catch (error) {
      if (generation !== this.generation) return;
      await this.panel.webview.postMessage({
        type: 'error',
        text: `角色数据加载失败：${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (generation !== this.generation || this.disposed) return;
    this.projectDir = projectDir;
    this.sources = result.sources;
    if (forceWatcher || !this.watcherDisposables.length) this.recreateWatchers(configuredPaths(projectDir));
    await this.panel.webview.postMessage({ type: 'data', snapshot: result.snapshot });
  }

  private recreateWatchers(paths: CharacterDataPaths): void {
    this.disposeWatchers();
    const schedule = () => {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => void this.update(false), 350);
    };
    const watch = (base: string, pattern: string) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      watcher.onDidChange(schedule);
      watcher.onDidCreate(schedule);
      watcher.onDidDelete(schedule);
      this.watcherDisposables.push(watcher);
    };
    watch(path.dirname(paths.masterFile), path.basename(paths.masterFile));
    watch(paths.skillsDir, '*.json');
    watch(path.dirname(paths.localeFile), path.basename(paths.localeFile));
    watch(path.dirname(paths.effectsFile), path.basename(paths.effectsFile));
  }

  private disposeWatchers(): void {
    for (const disposable of this.watcherDisposables) disposable.dispose();
    this.watcherDisposables = [];
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private sourceFor(message: CharacterManagerMessage): string | undefined {
    if (!this.sources) return undefined;
    switch (message.kind) {
      case 'character':
        if (message.characterId) return this.sources.characterFiles.get(message.characterId);
        if (message.fileName) return this.sources.characterFilesByName.get(message.fileName);
        return undefined;
      case 'master':
        return this.sources.masterFile;
      case 'locale':
        return this.sources.localeFile;
      case 'effects':
        return this.sources.effectsFile;
      default:
        return undefined;
    }
  }

  private async openSource(message: CharacterManagerMessage): Promise<void> {
    const file = this.sourceFor(message);
    if (!file || !fs.existsSync(file)) {
      void vscode.window.showWarningMessage('找不到对应源文件。');
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
    const needle = message.skillId || message.effectId || message.characterId;
    if (!needle) return;
    const text = document.getText();
    const offset = text.indexOf(`"${needle}"`);
    if (offset < 0) return;
    const position = document.positionAt(offset);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.disposeWatchers();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    if (CharacterManagerPanel.current === this) CharacterManagerPanel.current = undefined;
  }
}
