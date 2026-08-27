import * as vscode from 'vscode';
import { FeatureData } from './featureData';
import { cropTemplateThumbFile, openAnnotatedImage } from './pngCrop';
import { featureAliases } from './providers';

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
    void vscode.window.showWarningMessage(`没有可用的 Python 编辑器，已改为复制：${text}`);
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
    this.webview.html = galleryHtml(this.webview.cspSource);
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
        const file = cropTemplateThumbFile(meta.imagePath, meta.bbox, this.thumbDir, 96);
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
          void vscode.window.showInformationMessage(`已复制：${text}`);
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
          title: 'ok-lang-hints: 正在生成原图标注…',
        },
        async () => openAnnotatedImage(imagePath, name, bbox!, this.thumbDir, this.features.root),
      );
      if (!file) {
        void vscode.window.showWarningMessage('生成标注图失败：原图解码失败或文件缺失');
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
  public static readonly viewType = 'okLangHints.templateGallery';

  constructor(
    private readonly features: FeatureData,
    private readonly thumbDir: string,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      // 必须放行缩略图目录（globalStorage），否则 asWebviewUri 加载会被拒绝
      localResourceRoots: [vscode.Uri.file(this.thumbDir)],
    };
    const controller = new GalleryController(
      view.webview,
      this.features,
      this.thumbDir,
      () => view.visible,
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
  static show(features: FeatureData, thumbDir: string): void {
    if (TemplateGalleryPanel.current) {
      TemplateGalleryPanel.current.panel.reveal();
      void TemplateGalleryPanel.current.controller.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okLangHintsTemplates',
      '模板面板',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        // 必须放行缩略图目录（globalStorage），否则 asWebviewUri 加载会被拒绝
        localResourceRoots: [vscode.Uri.file(thumbDir)],
      },
    );
    const controller = new GalleryController(panel.webview, features, thumbDir, () => panel.visible);
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

function galleryHtml(cspSource: string): string {
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `img-src data: ${cspSource}`,
    `script-src ${cspSource} 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="zh-cn">
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
    margin: 0;
    padding: 10px 12px 20px;
  }
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 6px 0;
    background: var(--vscode-editor-background);
  }
  #search {
    flex: 1;
    min-width: 120px;
    padding: 4px 8px;
    border-radius: 3px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    outline: none;
  }
  #search:focus { border-color: var(--vscode-focusBorder); }
  #count { opacity: .75; font-size: 11px; white-space: nowrap; }
  .hint { opacity: .6; font-size: 11px; width: 100%; }
  #grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 8px;
    margin-top: 4px;
  }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,.08));
    transition: transform .08s ease, border-color .08s ease;
    user-select: none;
  }
  .card:hover { transform: translateY(-2px); border-color: var(--vscode-focusBorder); }
  .thumb-box {
    height: var(--thumb-h);
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      repeating-conic-gradient(rgba(128,128,128,.14) 0% 25%, transparent 0% 50%) 0 0/16px 16px;
  }
  .thumb-box img {
    max-width: 100%;
    max-height: 100%;
    image-rendering: pixelated;
    /* 注意：不要在这里写 display:none —— 内联 style.display='' 无法覆盖样式表规则，
       会导致图片加载成功却永远不可见。隐藏改用内联样式控制（见 attachThumb）。 */
  }
  .placeholder { opacity: .35; font-size: 11px; }
  .meta { padding: 5px 7px 6px; }
  .name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
  }
  .size { opacity: .65; font-size: 11px; }
  .empty {
    margin-top: 32px;
    text-align: center;
    opacity: .6;
    line-height: 1.8;
    white-space: pre-line;
    padding: 0 12px;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <input id="search" type="text" placeholder="搜索模板名…" />
    <span id="count"></span>
    <span class="hint">单击=插入到代码 · 双击=复制 · 点缩略图=查看原图（红框标注位置）</span>
  </div>
  <div id="grid"></div>
  <div id="empty" class="empty" style="display:none"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const search = document.getElementById('search');
  const countEl = document.getElementById('count');
  const emptyEl = document.getElementById('empty');
  const cards = new Map(); // name -> card element
  let metas = [];
  let loadedCount = 0;
  let failedCount = 0;

  function updateCount() {
    const base = shownCount() + '/' + metas.length + ' 个模板';
    const stat = (loadedCount || failedCount)
      ? ' · 缩略图 ' + loadedCount + ' 成功' + (failedCount ? ' / ' + failedCount + ' 失败' : '')
      : '';
    countEl.textContent = base + stat;
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
    card.title = meta.name + '\\n尺寸: ' + meta.width + '×' + meta.height +
      '\\nbbox: [' + meta.bbox.join(', ') + ']\\n来源: ' + meta.imagePath;

    const box = document.createElement('div');
    box.className = 'thumb-box';
    const ph = document.createElement('span');
    ph.className = 'placeholder';
    ph.textContent = '…';
    box.appendChild(ph);

    const m = document.createElement('div');
    m.className = 'meta';
    const nm = document.createElement('div');
    nm.className = 'name';
    nm.textContent = meta.name;
    nm.title = meta.name;
    const sz = document.createElement('div');
    sz.className = 'size';
    sz.textContent = meta.width + '×' + meta.height;
    m.appendChild(nm);
    m.appendChild(sz);

    card.appendChild(box);
    card.appendChild(m);

    let clickTimer = null;
    card.addEventListener('click', () => {
      // 延迟区分单击（插入）与双击（复制），避免双击误触发两次插入
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        vscode.postMessage({ type: 'insert', text: meta.name });
      }, 250);
    });
    card.addEventListener('dblclick', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      vscode.postMessage({ type: 'copy', text: meta.name });
    });
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({
        type: 'open',
        imagePath: meta.imagePath,
        name: meta.name,
        bbox: JSON.stringify(meta.bbox),
      });
    });
    return card;
  }

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const [name, card] of cards) {
      const ok = !q || name.toLowerCase().includes(q);
      card.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    updateCount();
    emptyEl.style.display = 'none';
    emptyEl.textContent = '';
    if (metas.length === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = '未找到任何模板。\\n请确认工作区存在 assets/coco_annotations.json\\n（或 ok_tasks/assets/coco_annotations.json）。';
    } else if (shown === 0) {
      emptyEl.style.display = '';
      emptyEl.textContent = '没有匹配「' + search.value.trim() + '」的模板。';
    }
  }

  search.addEventListener('input', applyFilter);

  /** 给卡片挂上缩略图；成功/失败都会更新计数 */
  function attachThumb(name, url) {
    const card = cards.get(name);
    if (!card || card.dataset.thumbDone === '1') return;
    card.dataset.thumbDone = '1';
    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    // 用内联样式隐藏（内联优先级高于样式表，onload 时才能可靠切回显示）
    img.style.display = 'none';
    img.addEventListener('load', () => {
      loadedCount++;
      const ph = card.querySelector('.placeholder');
      if (ph) ph.remove();
      img.style.display = 'block';
      updateCount();
    });
    img.addEventListener('error', () => {
      failedCount++;
      const ph = card.querySelector('.placeholder');
      if (ph) { ph.textContent = '加载失败'; ph.style.opacity = '.8'; }
      // 把失败的 URI 记到卡片 tooltip，便于诊断（如 localResourceRoots 未放行）
      card.title += '\\n[缩略图加载失败] ' + url;
      updateCount();
    });
    card.querySelector('.thumb-box').appendChild(img);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'templates': {
        grid.innerHTML = '';
        cards.clear();
        metas = msg.templates || [];
        loadedCount = 0;
        failedCount = 0;
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
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
