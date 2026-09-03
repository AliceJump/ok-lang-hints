import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TemplateAssetData } from './templateAssetData';
import { AnnotationPanel } from './annotationPanel';
import { cropTemplateThumbFile } from './pngCrop';
import { tr, webviewStrings } from './localization';

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
  ) {
    liveControllers.add(this);
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); }),
    );
  }

  attachHtml(): void {
    this.webview.html = assetGalleryHtml(this.webview.cspSource);
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
          AnnotationPanel.show(this.data, this.thumbDir, msg.imagePath, imageList, () => {
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
    // VS Code 没有直接的剪贴板图片读取 API，提示用户使用文件导入
    void vscode.window.showInformationMessage(
      tr('Use the Import button to add images from files. VS Code does not support direct clipboard image paste.'),
    );
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

    try {
      this.data.ensureTemplateFolder();
      this.data.saveToAssets(pick.target);
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
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(this.thumbDir)],
    };
    const controller = new AssetGalleryController(
      view.webview,
      this.data,
      this.thumbDir,
      () => view.visible,
    );
    controller.attachHtml();
    view.onDidChangeVisibility(() => { if (view.visible) void controller.update(); });
    view.onDidDispose(() => controller.dispose());
  }
}

/* ---------------- 编辑器面板 ---------------- */

export class TemplateAssetPanel {
  static current: TemplateAssetPanel | undefined;

  static show(data: TemplateAssetData, thumbDir: string): void {
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
        localResourceRoots: [vscode.Uri.file(thumbDir)],
      },
    );
    const controller = new AssetGalleryController(
      panel.webview,
      data,
      thumbDir,
      () => panel.visible,
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

function assetGalleryHtml(cspSource: string): string {
  const nonce = getNonce();
  const strings = JSON.stringify(webviewStrings()).replace(/</g, '\\u003c');
  const csp = [
    "default-src 'none'",
    `img-src data: ${cspSource} vscode-resource:`,
    `script-src ${cspSource} 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
  ].join('; ');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { --thumb-h: 96px; }
  body {
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    margin: 0; padding: 10px 12px 20px;
  }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 6px 0;
    background: var(--vscode-editor-background);
  }
  .toolbar button {
    padding: 4px 10px; border-radius: 3px;
    border: 1px solid var(--vscode-button-secondaryBackground, rgba(128,128,128,.3));
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer; font-size: 12px; white-space: nowrap;
  }
  .toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .toolbar button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .toolbar button.primary:hover { opacity: .9; }
  #search {
    flex: 1; min-width: 120px; padding: 4px 8px; border-radius: 3px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    outline: none; font-size: 12px;
  }
  #search:focus { border-color: var(--vscode-focusBorder); }
  #count { opacity: .75; font-size: 11px; white-space: nowrap; }
  .spacer { flex: 1; }
  #grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 8px; margin-top: 8px;
  }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    border-radius: 6px; overflow: hidden; cursor: pointer;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
    transition: transform .08s ease, border-color .08s ease;
    user-select: none;
  }
  .card:hover { transform: translateY(-2px); border-color: var(--vscode-focusBorder); }
  .thumb-box {
    height: var(--thumb-h);
    display: flex; align-items: center; justify-content: center;
    position: relative;
    background: repeating-conic-gradient(rgba(128,128,128,.14) 0% 25%, transparent 0% 50%) 0 0/16px 16px;
  }
  .thumb-box img { max-width: 100%; max-height: 100%; image-rendering: pixelated; }
  .placeholder { opacity: .35; font-size: 11px; }
  .meta { padding: 5px 7px 6px; }
  .name {
    font-weight: 600; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; margin-bottom: 2px; font-size: 11px;
  }
  .cats { opacity: .65; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .size { opacity: .5; font-size: 10px; }
  .actions {
    position: absolute; bottom: 3px; right: 3px;
    display: flex; gap: 2px; opacity: 0; transition: opacity .12s ease; z-index: 2;
  }
  .card:hover .actions { opacity: 1; }
  .actions button {
    width: 22px; height: 22px; border-radius: 4px;
    background: rgba(0,0,0,.6); color: #fff; border: none;
    cursor: pointer; font-size: 12px; line-height: 22px;
    text-align: center; padding: 0;
  }
  .actions button:hover { background: rgba(0,0,0,.85); }
  .empty {
    margin-top: 32px; text-align: center; opacity: .6;
    line-height: 1.8; white-space: pre-line; padding: 0 12px;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="primary" id="importBtn">Import</button>
    <button id="screenshotBtn">Screenshot</button>
    <button id="saveBtn">Save to Assets</button>
    <div class="spacer"></div>
    <input id="search" type="text" />
    <span id="count"></span>
  </div>
  <div id="grid"></div>
  <div id="empty" class="empty" style="display:none"></div>
<script nonce="${nonce}">
  const I18N = ${strings};
  const t = (key, args = {}) => (I18N[key] || key).replace(/\\{(\\w+)\\}/g, (_, name) => String(args[name] ?? '{' + name + '}'));
  const vscode = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const countEl = document.getElementById('count');
  const emptyEl = document.getElementById('empty');
  const cards = new Map();
  let metas = [];

  document.title = t('templateAssetsTitle');
  search.placeholder = t('templatesSearch');

  function updateCount() {
    const shown = shownCount();
    countEl.textContent = shown + '/' + metas.length;
  }
  function shownCount() {
    let n = 0;
    for (const card of cards.values()) if (card.style.display !== 'none') n++;
    return n;
  }

  function makeCard(meta) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.name = meta.name;
    card.title = meta.name + '\\n' + meta.width + 'x' + meta.height +
      (meta.categories.length ? '\\n' + meta.categories.join(', ') : '');

    const box = document.createElement('div');
    box.className = 'thumb-box';
    const ph = document.createElement('span');
    ph.className = 'placeholder';
    ph.textContent = '...';
    box.appendChild(ph);

    const actDiv = document.createElement('div');
    actDiv.className = 'actions';
    const annBtn = document.createElement('button');
    annBtn.textContent = 'Edit';
    annBtn.title = 'Annotate image';
    annBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'openAnnotation', imagePath: meta.imagePath });
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = 'X';
    delBtn.title = 'Delete image';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteImage', imagePath: meta.imagePath });
    });
    actDiv.appendChild(annBtn);
    actDiv.appendChild(delBtn);
    box.appendChild(actDiv);

    const m = document.createElement('div');
    m.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = meta.name;
    const cats = document.createElement('div');
    cats.className = 'cats';
    cats.textContent = meta.categories.length ? meta.categories.join(', ') : '';
    const sz = document.createElement('div');
    sz.className = 'size';
    sz.textContent = meta.width + 'x' + meta.height;
    m.appendChild(nm);
    m.appendChild(cats);
    m.appendChild(sz);

    card.appendChild(box);
    card.appendChild(m);
    card.addEventListener('click', () => {
      vscode.postMessage({ type: 'openAnnotation', imagePath: meta.imagePath });
    });
    return card;
  }

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const [name, card] of cards) {
      const meta = metas.find(m => m.name === name);
      const ok = !q || name.toLowerCase().includes(q) ||
        (meta && meta.categories.some(c => c.toLowerCase().includes(q)));
      card.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    updateCount();
    emptyEl.style.display = 'none';
    if (metas.length === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = t('noTemplatesWithHint');
    } else if (shown === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = 'No matching images for "' + search.value.trim() + '"';
    }
  }

  search.addEventListener('input', () => applyFilter());

  function attachThumb(name, url) {
    const card = cards.get(name);
    if (!card || card.dataset.thumbDone === '1') return;
    card.dataset.thumbDone = '1';
    const img = document.createElement('img');
    img.src = url; img.alt = name;
    img.style.display = 'none';
    img.addEventListener('load', () => {
      const ph = card.querySelector('.placeholder');
      if (ph) ph.remove();
      img.style.display = 'block';
    });
    img.addEventListener('error', () => {
      const ph = card.querySelector('.placeholder');
      if (ph) { ph.textContent = 'fail'; ph.style.opacity = '.8'; }
    });
    card.querySelector('.thumb-box').prepend(img);
  }

  document.getElementById('importBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'importFile' });
  });
  document.getElementById('screenshotBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'screenshot' });
  });
  document.getElementById('saveBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'saveToAssets' });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'templates': {
        grid.innerHTML = ''; cards.clear();
        metas = msg.templates || [];
        for (const meta of metas) {
          const card = makeCard(meta);
          cards.set(meta.name, card);
          grid.appendChild(card);
        }
        applyFilter();
        break;
      }
      case 'thumbs': {
        for (const it of (msg.items || [])) attachThumb(it.name, it.url);
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
