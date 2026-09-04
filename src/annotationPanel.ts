import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TemplateAssetData } from './templateAssetData';
import { injectWebviewLocalization, tr } from './localization';

/* ---------------- 标注数据类型 ---------------- */

interface Annotation {
  id: number;
  category: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ---------------- 控制器 ---------------- */

class AnnotationController {
  private generation = 0;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private _currentImage: string | undefined;
  private _imageList: string[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    private readonly data: TemplateAssetData,
    private readonly thumbDir: string,
    private readonly isVisible: () => boolean,
    private readonly onSaved: (imagePath: string) => void,
  ) {
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); }),
    );
  }

  get currentImage(): string | undefined { return this._currentImage; }

  attachHtml(): void {
    this.webview.html = annotationHtml(this.webview.cspSource, this.extensionUri, this.webview);
    this.sendKeybindings();
  }

  /** 读取扩展设置并发送快捷键配置到 webview */
  private sendKeybindings(): void {
    const cfg = vscode.workspace.getConfiguration('okScriptToolkit');
    const kb = cfg.get<Record<string, string>>('annotationKeybindings');
    if (kb) {
      void this.webview.postMessage({ type: 'config', keybindings: kb });
    }
  }

  open(imagePath: string, imageList: string[]): void {
    this._imageList = [...imageList];
    this._currentImage = imagePath;
    this.loadImage(imagePath);
  }

  private async loadImage(imagePath: string): Promise<void> {
    if (this.disposed) return;
    this._currentImage = imagePath;

    // 读取图片为 base64
    let imageBase64 = '';
    try {
      const buf = fs.readFileSync(imagePath);
      imageBase64 = `data:image/png;base64,${buf.toString('base64')}`;
    } catch {
      imageBase64 = '';
    }

    // 读取标注数据
    const annotations = this.data.getAnnotationsForImage(imagePath);

    // 获取所有分类名（用于验证唯一性）
    const allCategories: Record<string, string> = {};
    for (const img of this.data.data.images) {
      const imgPath = path.join(this.data.templatesDir, img.file_name);
      if (imgPath === imagePath) continue;
      const cats = this.data.getCategoriesForImage(imgPath);
      for (const c of cats) {
        allCategories[c] = img.file_name;
      }
    }

    const currentIndex = this._imageList.indexOf(imagePath);

    await this.webview.postMessage({
      type: 'load',
      imagePath,
      imageBase64,
      annotations: annotations.map((a) => ({
        id: a.id,
        category: a.categoryName,
        x: a.bbox[0],
        y: a.bbox[1],
        w: a.bbox[2],
        h: a.bbox[3],
      })),
      allCategories,
      currentIndex,
      totalImages: this._imageList.length,
      filename: path.basename(imagePath),
    });
  }

  private async onMessage(msg: {
    type?: string;
    annotation?: Annotation;
    annotations?: Annotation[];
    index?: number;
    category?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        if (this._currentImage) {
          await this.loadImage(this._currentImage);
        }
        break;
      case 'save': {
        if (!this._currentImage || !msg.annotations) break;
        this.data.setAnnotationsForImage(
          this._currentImage,
          msg.annotations.map((a) => ({ category: a.category, x: a.x, y: a.y, w: a.w, h: a.h })),
        );
        this.data.save();
        this.onSaved(this._currentImage);
        break;
      }
      case 'navigate': {
        if (msg.index === undefined || msg.index < 0 || msg.index >= this._imageList.length) break;
        await this.loadImage(this._imageList[msg.index]);
        break;
      }
      case 'deleteAnnotation': {
        if (!this._currentImage || !msg.annotation) break;
        const annotations = this.data.getAnnotationsForImage(this._currentImage);
        const annId = (msg.annotation as unknown as { id: number }).id;
        const filtered = annotations.filter((a) => a.id !== annId);
        this.data.setAnnotationsForImage(
          this._currentImage,
          filtered.map((a) => ({ category: a.categoryName, x: a.bbox[0], y: a.bbox[1], w: a.bbox[2], h: a.bbox[3] })),
        );
        this.data.save();
        this.onSaved(this._currentImage);
        // 重新加载
        await this.loadImage(this._currentImage);
        break;
      }
      case 'copyColor': {
        if (typeof msg.category === 'string') {
          await vscode.env.clipboard.writeText(msg.category);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text: msg.category }));
        }
        break;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ---------------- 面板 ---------------- */

export class AnnotationPanel {
  static current: AnnotationPanel | undefined;

  static show(
    extensionUri: vscode.Uri,
    data: TemplateAssetData,
    thumbDir: string,
    imagePath: string,
    imageList: string[],
    onSaved: (imagePath: string) => void,
  ): void {
    if (AnnotationPanel.current) {
      AnnotationPanel.current.panel.reveal();
      AnnotationPanel.current.controller.open(imagePath, imageList);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okScriptToolkitAnnotation',
      tr('Annotation Editor'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(thumbDir),
          vscode.Uri.file(data.templatesDir),
          extensionUri,
        ],
      },
    );
    const controller = new AnnotationController(
      panel.webview,
      extensionUri,
      data,
      thumbDir,
      () => panel.visible,
      onSaved,
    );
    AnnotationPanel.current = new AnnotationPanel(panel, controller);
    controller.open(imagePath, imageList);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    readonly controller: AnnotationController,
  ) {
    controller.attachHtml();
    panel.onDidDispose(() => {
      controller.dispose();
      AnnotationPanel.current = undefined;
    });
  }
}

/* ---------------- Nonce 生成 ---------------- */

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) value += possible.charAt(Math.floor(Math.random() * possible.length));
  return value;
}

/* ---------------- HTML ---------------- */

function annotationHtml(cspSource: string, extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const file = path.join(extensionUri.fsPath, 'media', 'annotationPanel', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'annotationPanel', name),
  ).toString(true);
  return injectWebviewLocalization(
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js')),
  );
}
