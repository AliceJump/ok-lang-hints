import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FeatureData } from './featureData';
import { cropTemplateThumbFileAsync, openAnnotatedImage, THUMB_HEIGHT } from './pngCrop';
import { featureAliases } from './providers';
import { injectWebviewLocalization, tr } from './localization';

/** 发送给 webview 的模板元数据（不含图片） */
interface TemplateMeta {
  name: string;
  width: number;
  height: number;
  bbox: [number, number, number, number];
  imagePath: string;
}

/* ---------------- 别名 ---------------- */

/** 面板中“插入”使用的别名前缀（取配置的第一个别名，默认 fL） */
export function primaryFeatureAlias(): string {
  const aliases = featureAliases();
  return aliases.length ? aliases[0] : 'fL';
}

/* ---------------- 最近 Python 编辑器跟踪（模块级单例） ---------------- */

let lastPythonEditor: vscode.TextEditor | undefined;
let editorTrackerReady = false;

function ensureEditorTracker(): void {
  if (editorTrackerReady) return;
  editorTrackerReady = true;
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && editor.document.languageId === 'python') lastPythonEditor = editor;
  });
  const cur = vscode.window.activeTextEditor;
  if (cur && cur.document.languageId === 'python') lastPythonEditor = cur;
}

/** 把文本插入最近活动的 Python 编辑器光标处；无可用编辑器时回退为复制 */
async function insertIntoPythonEditor(text: string): Promise<void> {
  let editor = lastPythonEditor;
  if (!editor || editor.document.isClosed) {
    const act = vscode.window.activeTextEditor;
    if (act && act.document.languageId === 'python') editor = act;
  }
  if (!editor) {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showWarningMessage(tr('No Python editor is available; copied instead: {text}', { text }));
    return;
  }
  await editor.insertSnippet(new vscode.SnippetString(text));
}

/* ---------------- 存活控制器注册表 ---------------- */

const liveControllers = new Set<GalleryController>();

/** 数据变化后刷新所有存活的模板视图（侧边栏 + 编辑器面板） */
export function repaintAllGalleries(): void {
  for (const c of [...liveControllers]) void c.update();
}

/* ---------------- 共享控制器 ---------------- */

/**
 * 管理一个 webview 的模板展示：消息处理、元数据推送、分批缩略图生成。
 * 被侧边栏 WebviewView 与编辑器 WebviewPanel 共用。
 */
class GalleryController {
  private generation = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly features: FeatureData,
    /** 缩略图 PNG 落盘目录（globalStorage），webview 经 asWebviewUri 访问 */
    private readonly thumbDir: string,
    private readonly isVisible: () => boolean,
    private readonly extensionUri: vscode.Uri,
  ) {
    liveControllers.add(this);
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => {
        void this.onMessage(msg);
      }),
    );
  }

  /** 设置 HTML；webview 就绪后其脚本会发 ready 触发首次加载 */
  attachHtml(): void {
    this.webview.html = galleryHtml(this.webview, this.webview.cspSource, this.extensionUri);
  }

  /** 收集全部模板并推送元数据 + 分批推送缩略图（本地文件 URI） */
  async update(): Promise<void> {
    if (this.disposed || !this.isVisible()) return;
    const gen = ++this.generation;

    this.features.refresh(true);
    const metas: TemplateMeta[] = [...this.features.all()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((ft) => ({
        name: ft.name,
        width: ft.width,
        height: ft.height,
        bbox: ft.bbox,
        imagePath: ft.imagePath,
      }));

    await this.webview.postMessage({ type: 'templates', templates: metas });
    if (gen !== this.generation) return;

    // 分批生成缩略图文件并合并成单条消息推送，让出事件循环避免卡 UI
    const batchSize = 6;
    for (let i = 0; i < metas.length; i += batchSize) {
      if (gen !== this.generation || this.disposed) return;
      const items: { name: string; url: string }[] = [];
      for (const meta of metas.slice(i, i + batchSize)) {
        const file = await cropTemplateThumbFileAsync(meta.imagePath, meta.bbox, this.thumbDir, THUMB_HEIGHT);
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

  private async onMessage(msg: { type?: string; name?: string; text?: string; imagePath?: string; bbox?: string }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.update();
        break;
      case 'copy':
        if (typeof msg.text === 'string' && msg.text) {
          const text = `${primaryFeatureAlias()}.${msg.text}`;
          await vscode.env.clipboard.writeText(text);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text }));
        }
        break;
      case 'insert':
        if (typeof msg.text === 'string' && msg.text) {
          ensureEditorTracker();
          await insertIntoPythonEditor(`${primaryFeatureAlias()}.${msg.text}`);
        }
        break;
      case 'open':
        if (
          typeof msg.imagePath === 'string' &&
          typeof msg.bbox === 'string' &&
          typeof msg.name === 'string'
        ) {
          await this.openOriginalWithMarker(msg.imagePath, msg.name, msg.bbox);
        }
        break;
      default:
        break;
    }
  }

  /** 打开原始截图（优先 ok_templates）并在 bbox 处画红框标注（结果缓存，重复点击秒开） */
  private async openOriginalWithMarker(imagePath: string, name: string, bboxJson: string): Promise<void> {
    let bbox: [number, number, number, number] | undefined;
    try {
      const arr = JSON.parse(bboxJson);
      if (Array.isArray(arr) && arr.length >= 4 && arr.every((n) => typeof n === 'number')) {
        bbox = [Math.round(arr[0]), Math.round(arr[1]), Math.round(arr[2]), Math.round(arr[3])];
      }
    } catch {
      // 解析失败忽略
    }
    if (!bbox) return;
    try {
      const file = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: tr('ok-lang-hints: Generating source image annotation…'),
        },
        async () => openAnnotatedImage(imagePath, name, bbox!, this.thumbDir, this.features.root),
      );
      if (!file) {
        void vscode.window.showWarningMessage(tr('Failed to generate annotated image: source image could not be decoded or was missing'));
        return;
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    } catch {
      // 打开失败忽略
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

/* ---------------- 侧边栏视图（活动栏图标点开） ---------------- */

export class TemplateGalleryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'okScriptToolkit.templateGallery';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly features: FeatureData,
    private readonly thumbDir: string,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      // 必须放行缩略图目录（globalStorage）和扩展 media 目录，否则 asWebviewUri 加载会被拒绝
      localResourceRoots: [vscode.Uri.file(this.thumbDir), this.extensionUri],
    };
    const controller = new GalleryController(
      view.webview,
      this.features,
      this.thumbDir,
      () => view.visible,
      this.extensionUri,
    );
    controller.attachHtml();

    // 从隐藏恢复可见时刷新数据
    view.onDidChangeVisibility(() => {
      if (view.visible) void controller.update();
    });
    view.onDidDispose(() => controller.dispose());
  }
}

/* ---------------- 编辑器面板（大窗口版本） ---------------- */

export class TemplateGalleryPanel {
  /** 当前打开的面板（全局唯一） */
  static current: TemplateGalleryPanel | undefined;

  /** 打开或聚焦编辑器版模板面板；已打开时刷新内容 */
  static show(features: FeatureData, thumbDir: string, extensionUri: vscode.Uri): void {
    if (TemplateGalleryPanel.current) {
      TemplateGalleryPanel.current.panel.reveal();
      void TemplateGalleryPanel.current.controller.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okScriptToolkitTemplates',
      tr('Template Gallery'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        // 必须放行缩略图目录（globalStorage）和扩展 media 目录，否则 asWebviewUri 加载会被拒绝
        localResourceRoots: [vscode.Uri.file(thumbDir), extensionUri],
      },
    );
    const controller = new GalleryController(panel.webview, features, thumbDir, () => panel.visible, extensionUri);
    TemplateGalleryPanel.current = new TemplateGalleryPanel(panel, controller);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    readonly controller: GalleryController,
  ) {
    controller.attachHtml();
    // 隐藏后再显示时重新生成内容（retainContextWhenHidden=false）
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) void this.controller.update();
    });
    panel.onDidDispose(() => {
      this.controller.dispose();
      TemplateGalleryPanel.current = undefined;
    });
  }
}

/* ---------------- HTML（两种视图共用） ---------------- */

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function galleryHtml(webview: vscode.Webview, cspSource: string, extensionUri: vscode.Uri): string {
  const file = path.join(extensionUri.fsPath, 'media', 'templatePanel', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'templatePanel', name),
  ).toString(true);
  return injectWebviewLocalization(
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(webview.cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js')),
  );
}
