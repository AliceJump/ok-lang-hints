import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { TemplateAssetData } from './templateAssetData';
import { AnnotationPanel } from './annotationPanel';
import { cropTemplateThumbFile } from './pngCrop';
import { injectWebviewLocalization, tr, webviewStrings } from './localization';

/** 窗口配置（从项目 config.py 的 windows 子字典提取） */
interface WindowConfig {
  exe?: string[];
  title?: string;
  hwnd_class?: string;
  top_hwnd_class?: string;
}

/** probe_window_config.py 返回结构 */
interface ProbeWindowConfigResult {
  ok: boolean;
  error?: string;
  config_path?: string;
  exe?: string[];
  title?: string;
  hwnd_class?: string;
  top_hwnd_class?: string;
}

/** 读取项目 config.py 的窗口匹配配置（通过 Python AST 解析，不导入模块）。 */
async function probeWindowConfig(projectDir: string, pythonPath: string): Promise<WindowConfig | undefined> {
  const scriptPath = path.join(path.dirname(__dirname), 'python', 'probe_window_config.py');
  if (!fs.existsSync(scriptPath)) return undefined;
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(pythonPath, [scriptPath, projectDir], {
        timeout: 10000,
        encoding: 'utf-8',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message));
        else resolve(stdout || '');
      });
    });
    // 取最后一行 JSON
    const lines = result.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as ProbeWindowConfigResult;
        if (parsed.ok) {
          return {
            exe: parsed.exe,
            title: parsed.title,
            hwnd_class: parsed.hwnd_class,
            top_hwnd_class: parsed.top_hwnd_class,
          };
        }
        return undefined;
      } catch { /* 跳过非 JSON 行 */ }
    }
  } catch { /* Python 不可用或脚本失败 */ }
  return undefined;
}

/** 读取 okLangHints 扩展配置中的项目路径和 Python 解释器 */
function getProjectConfig(): { projectDir: string; pythonPath: string } {
  const cfg = vscode.workspace.getConfiguration('okLangHints');
  let projectDir = cfg.get<string>('okScriptProjectPath') || '';
  projectDir = projectDir.replace(/^~/, process.env.USERPROFILE || '');
  projectDir = projectDir.replace(/[\\/]+$/, '');
  if (!projectDir) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    if (root && (fs.existsSync(path.join(root, 'src', 'config.py')) || fs.existsSync(path.join(root, 'config.py')))) {
      projectDir = root;
    }
  }
  const python = cfg.get<string>('okScriptPython') || '';
  let pythonPath = python;
  if (!pythonPath) {
    const venvPy = path.join(projectDir, '.venv', 'Scripts', 'python.exe');
    pythonPath = fs.existsSync(venvPy) ? venvPy : 'python';
  }
  return { projectDir, pythonPath };
}

/* ---------------- 控制器 ---------------- */

const liveControllers = new Set<AssetGalleryController>();

export function repaintAllAssetGalleries(): void {
  for (const c of [...liveControllers]) void c.update();
}

class AssetGalleryController {
  private generation = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly data: TemplateAssetData,
    private readonly thumbDir: string,
    private readonly isVisible: () => boolean,
    private readonly extensionUri: vscode.Uri,
  ) {
    liveControllers.add(this);
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); }),
    );
  }

  attachHtml(): void {
    this.webview.html = assetGalleryHtml(this.webview, this.extensionUri);
  }

  async update(): Promise<void> {
    if (this.disposed || !this.isVisible()) return;
    const gen = ++this.generation;

    this.data.load();
    const imageFiles = this.data.listImages();

    // 构建元数据
    const metas = imageFiles.map((imgPath) => {
      const cats = this.data.getCategoriesForImage(imgPath);
      const entry = this.data.getImageEntryForPath(imgPath);
      return {
        name: path.basename(imgPath),
        imagePath: imgPath,
        width: entry?.width ?? 0,
        height: entry?.height ?? 0,
        categories: cats,
      };
    });

    await this.webview.postMessage({ type: 'templates', templates: metas });
    if (gen !== this.generation) return;

    // 分批推送缩略图
    const batchSize = 8;
    for (let i = 0; i < metas.length; i += batchSize) {
      if (gen !== this.generation || this.disposed) return;
      const items: { name: string; url: string }[] = [];
      for (const meta of metas.slice(i, i + batchSize)) {
        const entry = this.data.getImageEntryForPath(meta.imagePath);
        const bbox: [number, number, number, number] = [0, 0, entry?.width ?? 100, entry?.height ?? 100];
        const file = cropTemplateThumbFile(meta.imagePath, bbox, this.thumbDir, 96);
        if (!file) continue;
        items.push({
          name: meta.name,
          url: this.webview.asWebviewUri(vscode.Uri.file(file)).toString(true),
        });
      }
      if (items.length) {
        await this.webview.postMessage({ type: 'thumbs', items });
      }
      if (gen !== this.generation || this.disposed) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (gen === this.generation && !this.disposed) {
      void this.webview.postMessage({ type: 'thumbDone' });
    }
  }

  private async onMessage(msg: {
    type?: string;
    name?: string;
    imagePath?: string;
    command?: string;
    base64Png?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.update();
        break;
      case 'openAnnotation': {
        if (msg.imagePath) {
          const imageList = this.data.listImages();
          AnnotationPanel.show(this.extensionUri, this.data, this.thumbDir, msg.imagePath, imageList, () => {
            void this.update();
          });
        }
        break;
      }
      case 'screenshot': {
        // 从剪贴板粘贴截图
        await this.handleScreenshot();
        break;
      }
      case 'saveToAssets': {
        await this.handleSaveToAssets();
        break;
      }
      case 'deleteImage': {
        if (msg.imagePath) {
          await this.handleDeleteImage(msg.imagePath);
        }
        break;
      }
      case 'importFile': {
        await this.handleImportFile();
        break;
      }
    }
  }

  /* ---------- 截图处理 ---------- */
  private async handleScreenshot(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(tr('No workspace folder open.'));
      return;
    }

    const { projectDir, pythonPath } = getProjectConfig();
    let windowConfig: WindowConfig | undefined;

    // 从项目 config.py 自动读取窗口匹配信息
    if (projectDir) {
      windowConfig = await probeWindowConfig(projectDir, pythonPath);
    }

    let titleRegex: string | undefined;
    let exeNames: string[] | undefined;
    let hwndClass: string | undefined;

    if (windowConfig && (windowConfig.exe || windowConfig.title || windowConfig.hwnd_class)) {
      // 自动读取成功，直接使用 config 中的窗口信息
      exeNames = windowConfig.exe;
      titleRegex = windowConfig.title;
      hwndClass = windowConfig.hwnd_class;
      const desc = [
        exeNames ? `exe: ${exeNames.join(', ')}` : '',
        titleRegex ? `title: ${titleRegex}` : '',
        hwndClass ? `class: ${hwndClass}` : '',
      ].filter(Boolean).join(' | ');
      void vscode.window.showInformationMessage(tr('Auto-detected window config: {config}', { config: desc }));
    } else {
      // 回退：让用户手动输入窗口标题正则
      titleRegex = await vscode.window.showInputBox({
        prompt: tr('Enter game window title pattern (regex), or leave empty for all windows'),
        placeHolder: 'e.g. EndField|Unity',
      });
      if (titleRegex === undefined) return; // user cancelled
    }

    const outputDir = path.join(folder.uri.fsPath, 'ok_templates');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate filename with timestamp
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const outputPath = path.join(outputDir, `screenshot_${ts}.png`);

    // Find the capture script
    const scriptPath = path.join(folder.uri.fsPath, 'scripts', 'capture_game_window.py');
    let captureScript: string | undefined;
    if (fs.existsSync(scriptPath)) {
      captureScript = scriptPath;
    } else {
      const extScriptsDir = path.join(path.dirname(__dirname), 'scripts');
      const extScriptPath = path.join(extScriptsDir, 'capture_game_window.py');
      if (fs.existsSync(extScriptPath)) {
        captureScript = extScriptPath;
      }
    }
    if (!captureScript) {
      void vscode.window.showErrorMessage(tr('Screenshot script not found. Please place capture_game_window.py in scripts/ directory.'));
      return;
    }

    // 构建传递给 capture 脚本的窗口配置 JSON
    const windowConfigJson = (exeNames || hwndClass || titleRegex)
      ? JSON.stringify({ exe: exeNames, title: titleRegex, hwnd_class: hwndClass })
      : undefined;

    return this.captureWithScript(captureScript, outputPath, titleRegex, windowConfigJson);
  }

  private captureWithScript(scriptPath: string, outputPath: string, titlePattern: string | undefined, configJson?: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const args: string[] = [scriptPath, outputPath];
      if (configJson) {
        // 使用 --config-json 传递窗口配置
        args.push('--config-json', configJson);
      } else if (titlePattern) {
        // 兼容旧模式：直接传正则
        args.push(titlePattern);
      }

      const { pythonPath } = getProjectConfig();
      execFile(pythonPath, args, { timeout: 10000 }, async (error, stdout, stderr) => {
        if (error) {
          void vscode.window.showErrorMessage(tr('Screenshot failed: {error}', { error: error.message }));
          resolve();
          return;
        }
        if (!fs.existsSync(outputPath)) {
          void vscode.window.showErrorMessage(tr('Screenshot failed: file not created'));
          resolve();
          return;
        }

        // Add to COCO data
        try {
          await TemplateAssetData.addImageToCoco(outputPath);
          void vscode.window.showInformationMessage(tr('Screenshot saved: {name}', { name: path.basename(outputPath) }));
          await this.update();
        } catch (e) {
          void vscode.window.showErrorMessage(tr('Screenshot saved but COCO update failed: {error}', { error: String(e) }));
        }
        resolve();
      });
    });
  }

  /* ---------- 保存到 assets ---------- */
  private async handleSaveToAssets(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage(tr('No workspace folder open.'));
      return;
    }
    const targets = [
      { label: 'assets', description: 'standalone app', folder: path.join(folder.uri.fsPath, 'assets') },
      { label: 'ok_tasks/assets', description: 'custom scripts', folder: path.join(folder.uri.fsPath, 'ok_tasks', 'assets') },
    ];

    const pick = await vscode.window.showQuickPick(
      targets.map((t) => ({ label: t.label, description: t.description, target: t.folder })),
      { placeHolder: tr('Save COCO data + images to...') },
    );
    if (!pick) return;

    // Ask about generating label enum
    const generateEnum = await vscode.window.showQuickPick(
      [
        { label: tr('Yes'), description: tr('Generate LabelEnum.py'), generate: true },
        { label: tr('No'), description: tr('Skip enum generation'), generate: false },
      ],
      { placeHolder: tr('Generate template enum file?') },
    );
    if (!generateEnum) return;

    try {
      this.data.ensureTemplateFolder();
      this.data.saveToAssets(pick.target, generateEnum.generate);
      void vscode.window.showInformationMessage(tr('Saved to: {path}', { path: pick.label }));
    } catch (e) {
      void vscode.window.showErrorMessage(tr('Save failed: {error}', { error: String(e) }));
    }
  }

  /* ---------- 删除图片 ---------- */
  private async handleDeleteImage(imagePath: string): Promise<void> {
    const name = path.basename(imagePath);
    const confirm = await vscode.window.showWarningMessage(
      tr("Delete '{name}'? This cannot be undone.", { name }),
      { modal: true },
      tr('Delete'),
    );
    if (confirm !== tr('Delete')) return;

    if (this.data.deleteImage(imagePath)) {
      void vscode.window.showInformationMessage(tr('Deleted: {name}', { name }));
      await this.update();
    } else {
      void vscode.window.showErrorMessage(tr('Failed to delete: {name}', { name }));
    }
  }

  /* ---------- 导入文件 ---------- */
  private async handleImportFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      filters: { Images: ['png', 'jpg', 'jpeg', 'bmp', 'webp'] },
      title: tr('Import images to ok_templates'),
    });
    if (!uris || uris.length === 0) return;

    this.data.ensureTemplateFolder();
    let count = 0;
    for (const uri of uris) {
      try {
        const ext = path.extname(uri.fsPath);
        const name = this.data.nextImageName() + ext;
        const dst = path.join(this.data.templatesDir, name);
        fs.copyFileSync(uri.fsPath, dst);
        // 读取尺寸
        const buf = fs.readFileSync(dst);
        const dims = readPngDimensions(buf);
        this.data.addImageEntry(dst, dims.width, dims.height);
        count++;
      } catch {
        // 跳过失败的文件
      }
    }
    if (count > 0) {
      this.data.save();
      void vscode.window.showInformationMessage(tr('Imported {count} image(s)', { count: String(count) }));
      await this.update();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    liveControllers.delete(this);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ---------- 简易 PNG 尺寸读取 ---------- */

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    return { width: 0, height: 0 };
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/* ---------------- 侧边栏视图 ---------------- */

export class TemplateAssetViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okLangHints.templateAssets';

  constructor(
    private readonly data: TemplateAssetData,
    private readonly thumbDir: string,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.thumbDir), this.extensionUri],
    };
    const controller = new AssetGalleryController(
      view.webview,
      this.data,
      this.thumbDir,
      () => view.visible,
      this.extensionUri,
    );
    controller.attachHtml();
    view.onDidChangeVisibility(() => { if (view.visible) void controller.update(); });
    view.onDidDispose(() => controller.dispose());
  }
}

/* ---------------- 编辑器面板 ---------------- */

export class TemplateAssetPanel {
  static current: TemplateAssetPanel | undefined;

  static show(data: TemplateAssetData, thumbDir: string, extensionUri: vscode.Uri): void {
    if (TemplateAssetPanel.current) {
      TemplateAssetPanel.current.panel.reveal();
      void TemplateAssetPanel.current.controller.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okLangHintsTemplateAssets',
      tr('Template Assets'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(thumbDir), extensionUri],
      },
    );
    const controller = new AssetGalleryController(
      panel.webview,
      data,
      thumbDir,
      () => panel.visible,
      extensionUri,
    );
    TemplateAssetPanel.current = new TemplateAssetPanel(panel, controller);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    readonly controller: AssetGalleryController,
  ) {
    controller.attachHtml();
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) void this.controller.update();
    });
    panel.onDidDispose(() => {
      this.controller.dispose();
      TemplateAssetPanel.current = undefined;
    });
  }
}

/* ---------------- HTML ---------------- */

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 24; i++) value += possible.charAt(Math.floor(Math.random() * possible.length));
  return value;
}

function assetGalleryHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const file = path.join(extensionUri.fsPath, 'media', 'templateAssetPanel', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'templateAssetPanel', name),
  ).toString(true);
  return injectWebviewLocalization(
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js')),
  );
}
